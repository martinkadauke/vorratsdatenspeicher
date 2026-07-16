/** Generic, AI-assisted bank-CSV import.
 *
 * Banks all export different columns. Instead of a parser per bank, we detect the format
 * ONCE (an LLM reasons over the header + a few sample rows and emits a `CsvMappingSpec`),
 * then REPLAY that spec deterministically on every future import of the same format — keyed
 * by a fingerprint of the header row. comdirect keeps its bespoke parser (bankCsv.ts) because
 * it hides the counterparty/Ref inside a free-text field a column-map can't express; every
 * other bank flows through here.
 */
import { createHash } from 'node:crypto';
import type { ParsedTx, ParseResult } from './bankCsv.js';
import { providerForTask } from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';

export interface CsvColumnMap {
  booking_date: string | number;                 // required
  value_date?: string | number | null;
  amount?: string | number | null;               // single SIGNED column (Belastung < 0)
  debit?: string | number | null;                // OR: separate debit column (positive magnitude → made negative)
  credit?: string | number | null;               // OR: separate credit column (positive)
  counterparty?: string | number | null;
  description?: string | number | null;
  ref?: string | number | null;                  // bank's own unique reference (dedup key); else synthesized
}

export interface CsvMappingSpec {
  encoding: 'utf-8' | 'latin1';
  delimiter: string;                              // ';' | ',' | '\t' | '|'
  header_contains: string[];                      // substrings that identify the header row (skips preamble)
  columns: CsvColumnMap;
  date_format: 'DD.MM.YYYY' | 'DD.MM.YY' | 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD/MM/YYYY';
  decimal_sep: ',' | '.';
  thousands_sep: ',' | '.' | ' ' | '';
}

// ── low-level helpers ───────────────────────────────────────────────────
const deQuote = (s: string): string => s.replace(/^"|"$/g, '').replace(/""/g, '"').trim();

/** Split a delimited line honouring double-quoted fields. */
export function splitDelim(line: string, delim: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === delim && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function parseDate(raw: string, fmt: CsvMappingSpec['date_format']): string | null {
  const s = (raw || '').trim();
  let m: RegExpMatchArray | null;
  switch (fmt) {
    case 'YYYY-MM-DD': m = s.match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
    case 'DD.MM.YYYY': m = s.match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    case 'DD.MM.YY':   m = s.match(/(\d{2})\.(\d{2})\.(\d{2})(?!\d)/); return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
    case 'MM/DD/YYYY': m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
    case 'DD/MM/YYYY': m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    default: return null;
  }
}

function parseAmount(raw: string, decimal: ',' | '.', thousands: string): number | null {
  if (raw == null) return null;
  let s = String(raw).replace(/[^\d.,\-+]/g, '').trim(); // strip currency symbols/spaces
  if (!s) return null;
  if (thousands) s = s.split(thousands).join('');
  if (decimal === ',') s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ── sniffing ─────────────────────────────────────────────────────────────
export interface Sniffed { encoding: 'utf-8' | 'latin1'; text: string; delimiter: string; headerLine: string; headerIdx: number; sampleRows: string[]; }

/** Decode + guess delimiter + locate the header row. Encoding: prefer UTF-8, fall back to
 *  Latin-1 when UTF-8 yields replacement characters (typical for German bank exports). */
export function sniffCsv(buf: Buffer): Sniffed {
  let text = buf.toString('utf-8');
  let encoding: 'utf-8' | 'latin1' = 'utf-8';
  if (text.includes('�')) { text = buf.toString('latin1'); encoding = 'latin1'; }
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  // delimiter = the candidate that appears most in the densest early line
  const cand = [';', ',', '\t', '|'];
  const scoreLine = (l: string, d: string) => (l.split(d).length - 1);
  const probe = lines.slice(0, 25).filter(l => l.trim());
  let delimiter = ';', best = -1;
  for (const d of cand) { const s = Math.max(0, ...probe.map(l => scoreLine(l, d))); if (s > best) { best = s; delimiter = d; } }
  // header = the earliest line with the most delimited fields (≥ 3) — banks put a preamble above it
  let headerIdx = 0, hb = -1;
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const n = splitDelim(lines[i], delimiter).length;
    if (n >= 3 && n > hb) { hb = n; headerIdx = i; }
  }
  return { encoding, text, delimiter, headerLine: lines[headerIdx] ?? '', headerIdx, sampleRows: lines.slice(headerIdx + 1).filter(l => l.trim()).slice(0, 8) };
}

/** Stable key for a CSV format: the sorted, normalised column names. Same layout → same key,
 *  regardless of row content, so a bank is recognised on every future import. */
export function fingerprintHeader(headerLine: string, delimiter: string): string {
  const cols = splitDelim(headerLine, delimiter).map(c => norm(deQuote(c))).filter(Boolean).sort();
  return createHash('sha1').update(cols.join('|')).digest('hex').slice(0, 16);
}

// ── applier ────────────────────────────────────────────────────────────
/** Apply a mapping spec deterministically to the decoded CSV text → ParsedTx rows. */
export function applyCsvMapping(spec: CsvMappingSpec, text: string): ParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const need = (spec.header_contains ?? []).map(norm);
  let headerIdx = lines.findIndex(l => { const nl = norm(l); return need.length ? need.every(s => nl.includes(s)) : false; });
  if (headerIdx < 0) headerIdx = 0;
  const headerCols = splitDelim(lines[headerIdx], spec.delimiter).map(c => norm(deQuote(c)));
  const nameIdx = new Map(headerCols.map((c, i) => [c, i]));
  const resolve = (col: string | number | null | undefined): number => {
    if (col == null) return -1;
    if (typeof col === 'number') return col;
    const byName = nameIdx.get(norm(col));
    return byName != null ? byName : -1;
  };
  const cx = {
    booking: resolve(spec.columns.booking_date), value: resolve(spec.columns.value_date),
    amount: resolve(spec.columns.amount), debit: resolve(spec.columns.debit), credit: resolve(spec.columns.credit),
    cp: resolve(spec.columns.counterparty), desc: resolve(spec.columns.description), ref: resolve(spec.columns.ref),
  };
  const rows: ParsedTx[] = []; let skipped = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]; if (!line.trim()) continue;
    const f = splitDelim(line, spec.delimiter).map(deQuote);
    const booking = cx.booking >= 0 ? parseDate(f[cx.booking] ?? '', spec.date_format) : null;
    let amount: number | null = null;
    if (cx.amount >= 0) amount = parseAmount(f[cx.amount] ?? '', spec.decimal_sep, spec.thousands_sep);
    else if (cx.debit >= 0 || cx.credit >= 0) {
      const d = cx.debit >= 0 ? parseAmount(f[cx.debit] ?? '', spec.decimal_sep, spec.thousands_sep) : null;
      const c = cx.credit >= 0 ? parseAmount(f[cx.credit] ?? '', spec.decimal_sep, spec.thousands_sep) : null;
      if (c != null && c !== 0) amount = Math.abs(c);
      else if (d != null && d !== 0) amount = -Math.abs(d);
    }
    if (!booking || amount == null) { skipped++; continue; } // preamble / footer / balance line
    const counterparty = cx.cp >= 0 ? (f[cx.cp]?.trim() || null) : null;
    const description = cx.desc >= 0 ? (f[cx.desc] ?? '') : (counterparty ?? '');
    // Dedup key: the bank's own ref if present, else a stable synthetic key so re-importing an
    // overlapping export never duplicates.
    const ref = cx.ref >= 0 && f[cx.ref]?.trim()
      ? f[cx.ref].trim()
      : `syn:${booking}|${amount.toFixed(2)}|${norm(description).slice(0, 40)}`;
    rows.push({ booking_date: booking, value_date: cx.value >= 0 ? parseDate(f[cx.value] ?? '', spec.date_format) : null, purchase_date: null, amount, counterparty, vorgang: '', description, ref, raw: line });
  }
  return { account: null, period: null, rows, skipped };
}

// ── AI generator ─────────────────────────────────────────────────────────
const MAPPING_PROMPT = `Du bist ein Experte für Bank-CSV-Exporte. Du bekommst die KOPFZEILE und ein paar BEISPIELZEILEN eines Kontoauszug-CSV (beliebige Bank/Land). Erzeuge eine Zuordnung ("mapping spec"), mit der jede Zeile in ein einheitliches Schema übersetzt wird.

Zielschema pro Buchung: booking_date (Buchungsdatum), value_date (Wertstellung, optional), amount (Betrag, VORZEICHEN: Belastung/Ausgabe negativ, Gutschrift positiv), counterparty (Empfänger/Auftraggeber), description (Verwendungszweck/Text), ref (bankeigene eindeutige Referenz, falls vorhanden).

Antworte AUSSCHLIESSLICH mit gültigem JSON in genau dieser Struktur (keine Prosa, keine Code-Fences):
{"delimiter": ";"|","|"\\t"|"|", "header_contains": ["<2-3 Wörter die die Kopfzeile eindeutig erkennen>"], "columns": {"booking_date":"<Spaltenname>", "value_date":"<Spaltenname>"|null, "amount":"<Spaltenname>"|null, "debit":"<Spaltenname>"|null, "credit":"<Spaltenname>"|null, "counterparty":"<Spaltenname>"|null, "description":"<Spaltenname>"|null, "ref":"<Spaltenname>"|null}, "date_format": "DD.MM.YYYY"|"DD.MM.YY"|"YYYY-MM-DD"|"MM/DD/YYYY"|"DD/MM/YYYY", "decimal_sep": ","|".", "thousands_sep": ","|"."|" "|""}

Regeln:
- Spaltennamen EXAKT wie in der Kopfzeile. Wenn eine Zielspalte fehlt: null.
- Betrag: Gibt es EINE vorzeichenbehaftete Spalte → "amount" setzen, "debit"/"credit" null. Gibt es getrennte Soll-/Haben-Spalten → "debit" (Ausgabe, positiver Betrag) und "credit" (Eingang) setzen, "amount" null.
- date_format am Beispiel ablesen (z.B. "14.07.2026" → DD.MM.YYYY, "2026-07-14" → YYYY-MM-DD).
- decimal_sep/thousands_sep am Betragsbeispiel ablesen (z.B. "1.234,56" → decimal "," thousands "." ; "1,234.56" → decimal "." thousands ",").`;

export async function generateCsvMapping(headerLine: string, sampleRows: string[]): Promise<CsvMappingSpec> {
  const llm = await providerForTask('csvmapping');
  const out = await llm.chat({
    system: MAPPING_PROMPT,
    user: JSON.stringify({ kopfzeile: headerLine, beispielzeilen: sampleRows.slice(0, 8) }),
    json: true,
  });
  const p = parseLlmJson<Partial<CsvMappingSpec>>(out);
  // The model doesn't know the encoding; sniff owns that. Fill/validate the rest.
  return {
    encoding: 'utf-8',
    delimiter: p.delimiter || ';',
    header_contains: Array.isArray(p.header_contains) && p.header_contains.length ? p.header_contains : [],
    columns: {
      booking_date: p.columns?.booking_date ?? 0,
      value_date: p.columns?.value_date ?? null,
      amount: p.columns?.amount ?? null,
      debit: p.columns?.debit ?? null,
      credit: p.columns?.credit ?? null,
      counterparty: p.columns?.counterparty ?? null,
      description: p.columns?.description ?? null,
      ref: p.columns?.ref ?? null,
    },
    date_format: p.date_format || 'DD.MM.YYYY',
    decimal_sep: p.decimal_sep || ',',
    thousands_sep: p.thousands_sep ?? '.',
  };
}
