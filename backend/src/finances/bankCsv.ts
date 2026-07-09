/** comdirect "Umsätze Girokonto" CSV parser.
 *
 * Format: Latin-1, semicolon-separated, quoted fields, a short preamble, then a
 * header row `"Buchungstag";"Wertstellung (Valuta)";"Vorgang";"Buchungstext";"Umsatz in EUR";`
 * followed by one row per transaction. The Buchungstext embeds the counterparty
 * (`Auftraggeber:` / `Empfänger:`), a unique `Ref.` code (our dedup key) and, for
 * card payments, the real purchase date (the booking date lags a few days).
 */

export interface ParsedTx {
  booking_date: string;        // ISO YYYY-MM-DD (Buchungstag)
  value_date: string | null;   // ISO (Wertstellung)
  purchase_date: string | null; // ISO — real card purchase date if present
  amount: number;              // signed: < 0 = Belastung, > 0 = Gutschrift
  counterparty: string | null; // Auftraggeber / Empfänger / merchant
  vorgang: string;             // e.g. "Lastschrift / Belastung"
  description: string;         // full Buchungstext
  ref: string | null;          // unique transaction reference
  raw: string;                 // original CSV line
}

const deQuote = (s: string): string => s.replace(/^"|"$/g, '').replace(/""/g, '"').trim();

/** Split a semicolon-separated line, honouring double-quoted fields. */
function splitSemis(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (c === ';' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const toIso = (d: string): string | null => {
  const m = d.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const toAmount = (s: string): number | null => {
  const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function extractCounterparty(text: string): string | null {
  let m = text.match(/Auftraggeber:\s*(.+?)\s+Buchungstext:/);
  if (m) return m[1].trim();
  // "Empfänger: X Kto/IBAN:" — the delimiter can be glued to X ("DRadioKto/IBAN").
  m = text.match(/Empfänger:\s*(.+?)\s*(?:Kto\/IBAN|BLZ\/BIC|Buchungstext):/);
  if (m) return m[1].trim();
  // Card payment: "  Buchungstext: MERCHANT, CITY XX Karte Nr. …"
  m = text.match(/Buchungstext:\s*(.+?)(?:\s+Karte Nr\.|\s+Ref\.|$)/);
  if (m) return m[1].trim() || null;
  return null;
}

const extractRef = (t: string): string | null => {
  const m = t.match(/Ref\.\s*(\S+)/);
  return m ? m[1] : null;
};
const extractPurchaseDate = (t: string): string | null => {
  const m = t.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

export interface ParseResult {
  account: string | null;   // account number from the preamble
  period: string | null;    // "01.01.2026 - 09.07.2026"
  rows: ParsedTx[];
  skipped: number;          // non-transaction lines skipped (preamble/footer)
}

/** Parse the decoded CSV text. Robust to the preamble/footer lines comdirect adds. */
export function parseComdirectCsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => /"Buchungstag"/.test(l) && /"Umsatz in EUR"/.test(l));
  const preamble = headerIdx >= 0 ? lines.slice(0, headerIdx) : lines;
  const accM = preamble.join('\n').match(/Girokonto\s*-\s*(\d+)/);
  const perM = preamble.join('\n').match(/Zeitraum:\s*([\d.]+\s*-\s*[\d.]+)/);

  const rows: ParsedTx[] = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = splitSemis(line).map(deQuote);
    // A transaction row has ≥5 columns whose first is a date and 5th an amount.
    const booking = f.length >= 5 ? toIso(f[0]) : null;
    const amount = f.length >= 5 ? toAmount(f[4]) : null;
    if (!booking || amount == null) { skipped++; continue; } // preamble/footer (Kontostand …)
    const btext = f[3] ?? '';
    rows.push({
      booking_date: booking,
      value_date: toIso(f[1] ?? '') ,
      purchase_date: extractPurchaseDate(btext),
      amount,
      counterparty: extractCounterparty(btext),
      vorgang: f[2] ?? '',
      description: btext,
      ref: extractRef(btext),
      raw: line,
    });
  }
  return { account: accM ? accM[1] : null, period: perM ? perM[1].trim() : null, rows, skipped };
}
