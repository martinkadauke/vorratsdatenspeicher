import { todayLocal } from '../lib/localDate.js';
// The NL analytics agent. The LLM's ONLY job is to translate a question into a
// dashboard SPEC made of catalog keys — it never writes SQL and never emits a
// number. The backend validates every tile against the catalog, executes it on
// the read-only connection, and returns the figures. So the worst a bad model
// can do is pick a wrong-but-valid metric; it can never hallucinate a value or
// touch data.

import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { providerForTask } from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';
import { buildAnalyticsSql, runAnalyticsQuery, type AnalyticsResult } from './query.js';
import { METRICS, DIMENSIONS, GRAINS, SOURCES, type AnalyticsQuery } from './catalog.js';
import type { User } from '../types.js';

const TILE_TYPES = ['kpi', 'line', 'area', 'bar', 'pie', 'table'] as const;
type TileType = (typeof TILE_TYPES)[number];

/** Force the chart type to match the query shape so the LLM can't pick a chart
 *  that renders nonsense (pie over a time series, line without a time grain …). */
function coerceTileType(req: TileType, q: AnalyticsQuery): TileType {
  const dims = q.dimensions?.length ?? 0;
  const grain = q.grain ?? null;
  if (req === 'pie') return dims === 1 && !grain ? 'pie' : grain ? 'line' : 'bar';
  if (req === 'line' || req === 'area') return grain ? req : 'bar';
  return req; // kpi / bar / table render for any shape
}

interface SpecTile { type?: string; title?: string; query: AnalyticsQuery }
interface AgentSpec { clarify?: string | null; options?: string[]; chip?: string; title?: string; summary?: string; tiles?: SpecTile[] }

export interface DashboardTile {
  type: TileType; title: string;
  rows: AnalyticsResult['rows']; columns: AnalyticsResult['columns']; sql: string;
}
export interface AskResult {
  clarify?: string | null;
  options?: string[];          // clickable answer choices for a clarify (yes/no, a list …)
  chip?: string;               // 1–3 word label of the question, for the recent-queries strip
  title?: string;
  summary?: string;
  tiles: DashboardTile[];
  dropped: number;
}
export interface PriorTurn { question: string; clarify: string }

function catalogText(): string {
  const metrics = Object.values(METRICS).map(m => `  - ${m.key}: ${m.label} (${m.unit})`).join('\n');
  const dims = Object.values(DIMENSIONS).map(d => `  - ${d.key}: ${d.label}`).join('\n');
  const sources = Object.entries(SOURCES).map(([k, v]) => `  - ${k}: ${v.label}`).join('\n');
  return [
    `METRIKEN (Feld "metric"):\n${metrics}`,
    `DIMENSIONEN (Feld "dimensions": string[]):\n${dims}`,
    `ZEITRASTER (Feld "grain"): ${GRAINS.join(', ')}`,
    `QUELLE-WERTE (filters.source: string[]):\n${sources}`,
  ].join('\n\n');
}

function systemPrompt(lang: string): string {
  return `Du bist der Analytics-Agent von VDS, einem Haushalts-Finanz- und Ausgaben-Tracker.
Aufgabe: die Frage des Nutzers in eine DASHBOARD-SPEZIFIKATION übersetzen, die das System danach selbst ausführt und rendert.

HARTE REGELN (oberste Priorität):
- Wähle Metrik, Dimensionen, Zeitraster und Filter AUSSCHLIESSLICH aus dem Katalog unten – per exaktem Key.
- Schreibe NIEMALS SQL.
- Nenne NIEMALS konkrete Zahlen oder Beträge. Das System berechnet und rendert alle Werte. Das Feld "summary" ist nur eine kurze, neutrale Einordnung OHNE Zahlen.
- Ist die Frage mehrdeutig oder mit dem Katalog nicht beantwortbar: setze "clarify" auf eine kurze Rückfrage und lass "tiles" leer.
- Wenn du eine Rückfrage stellst und es eine Ja/Nein-Frage oder eine Auswahl ist (z.B. ein Familienmitglied, ein Zeitraum, "Ausgaben"/"Einnahmen"), gib ZUSÄTZLICH "options" an: 2–5 kurze, anklickbare Antworten als Strings. Bei einer wirklich freien Rückfrage lass "options" weg.

Vorzeichen: Ausgaben negativ, Einnahmen positiv. Metrik "spend" = positive Ausgabensumme, "income" = positive Einnahmen, "net" = Saldo (Einnahmen − Ausgaben).
Dimension "family_member" = Ausgaben pro Person (der Artikelpreis wird auf die zugeordneten Personen aufgeteilt) — nur mit Metrik "spend" sinnvoll, kombinierbar mit category/product/Zeitraster.

${catalogText()}

FILTER (Feld "filters", alle optional):
  - from / to: ISO-Datum YYYY-MM-DD, inklusive
  - category: Kategorie-Pfad (trifft den Pfad und seine Unterkategorien)
  - source: Array von Quelle-Keys (siehe oben)
  - direction: "expense" | "income"
  - konto_id: Array von Konto-IDs
  - merchant: Teilstring Händler/Laden
  - product: Teilstring Produktname
  - min_amount / max_amount: Betragsgrenzen (auf |Betrag|)
  - exclude_meta: bool (Default true; entfernt Pfand/Rabatt)

TILE-TYPEN (Feld "type"): kpi (Einzelwert, ohne grain/dimensions), line/area (Zeitreihe, braucht grain), bar/pie (nach genau 1 dimension), table (beliebig).

Gib außerdem "chip" an: ein sehr kurzes Label (1–3 Wörter, wenige Zeichen) das die Frage zusammenfasst, z.B. "Katzen Kosten" für „wie viel geben wir für Katzen aus".

Antworte mit GENAU diesem JSON (keine Erklärung drumherum):
{"clarify": null, "options": null, "chip": "...", "title": "...", "summary": "...", "tiles": [{"type":"kpi","title":"...","query":{"metric":"spend","grain":"month","dimensions":["category"],"filters":{"from":"2026-01-01"},"limit":12}}]}

Sprache der Texte (title/summary/clarify): ${lang === 'en' ? 'Englisch' : 'Deutsch'}. Baue 1–5 sinnvolle, sich ergänzende Tiles (z.B. KPI-Summe + Zeitreihe + Breakdown).`;
}

interface Ctx { today: string; lo: string | null; hi: string | null; categories: string[]; konten: string[]; members: string[] }

function userPrompt(question: string, ctx: Ctx, prior?: PriorTurn): string {
  const head = `Heute: ${ctx.today}. Verfügbarer Datenbereich: ${ctx.lo ?? '—'} bis ${ctx.hi ?? '—'}.
Oberste Kategorien: ${ctx.categories.join(', ') || '—'}.
Konten: ${ctx.konten.join(', ') || '—'}.
Familienmitglieder: ${ctx.members.join(', ') || '—'}.`;
  if (prior) {
    return `${head}

Dies ist eine Folgeantwort. Ursprüngliche Frage: "${prior.question}". Deine Rückfrage war: "${prior.clarify}". Der Nutzer antwortet jetzt: "${question}". Baue daraus die Dashboard-Spezifikation — frage nur erneut nach, wenn es WIRKLICH noch unklar ist.`;
  }
  return `${head}

Frage: "${question}"`;
}

async function loadContext(user: User | undefined): Promise<Ctx> {
  const ks = kontoScope(user, sql`t`);
  const [range] = await sql`
    SELECT to_char(MIN(datum), 'YYYY-MM-DD') AS lo, to_char(MAX(datum), 'YYYY-MM-DD') AS hi
    FROM v_transactions t WHERE TRUE ${ks}`;
  const cats = await sql`SELECT display FROM category WHERE level = 1 ORDER BY sort_order, display`;
  // Accounts are no longer hidden — list all for grounding (private receipts stay
  // hidden via the privacy filter on the data itself).
  const konten = await sql`SELECT name FROM konto ORDER BY sort_order, id`;
  const members = await sql`SELECT name FROM family_member ORDER BY sort_order, name`;
  return {
    today: todayLocal(),
    lo: (range?.lo as string | null) ?? null,
    hi: (range?.hi as string | null) ?? null,
    categories: cats.map(c => c.display as string),
    konten: konten.map(k => k.name as string),
    members: members.map(m => m.name as string),
  };
}

async function logAsk(
  user: User | undefined, question: string, spec: AgentSpec | null, ok: boolean, error: string | null,
): Promise<void> {
  try {
    await sql`
      INSERT INTO nlanalytics_log (user_id, question, spec, ok, error)
      VALUES (${user?.id ?? null}, ${question}, ${spec ? sql.json(spec as never) : null}, ${ok}, ${error})`;
  } catch { /* observability only — never break the request */ }
}

export async function askAnalytics(question: string, user: User | undefined, lang = 'de', prior?: PriorTurn): Promise<AskResult> {
  const ctx = await loadContext(user);
  const provider = await providerForTask('nlanalytics');
  const raw = await provider.chat({ system: systemPrompt(lang), user: userPrompt(question, ctx, prior), json: true });

  let spec: AgentSpec;
  try {
    spec = parseLlmJson<AgentSpec>(raw);
  } catch {
    await logAsk(user, question, null, false, 'parse_failed');
    return {
      clarify: lang === 'en'
        ? "I couldn't interpret that. Try e.g. \"spending on groceries in the last 6 weeks\"."
        : 'Das konnte ich nicht deuten. Versuch z.B. „Ausgaben für Lebensmittel der letzten 6 Wochen".',
      tiles: [], dropped: 0,
    };
  }

  const chip = typeof spec.chip === 'string' && spec.chip.trim() ? spec.chip.trim().slice(0, 30) : undefined;

  if (spec.clarify) {
    await logAsk(user, question, spec, true, null);
    const options = Array.isArray(spec.options)
      ? spec.options.filter(o => typeof o === 'string' && o.trim()).slice(0, 6)
      : undefined;
    return { clarify: spec.clarify, options: options?.length ? options : undefined, chip, tiles: [], dropped: 0 };
  }

  const tiles: DashboardTile[] = [];
  let dropped = 0;
  for (const t of (spec.tiles ?? []).slice(0, 6)) {
    const reqType: TileType = (TILE_TYPES as readonly string[]).includes(t.type ?? '') ? (t.type as TileType) : 'table';
    const type = coerceTileType(reqType, t.query);
    try {
      buildAnalyticsSql(t.query, user);              // validate against the catalog (throws on bad keys)
      const res = await runAnalyticsQuery(t.query, user);
      tiles.push({ type, title: t.title ?? '', rows: res.rows, columns: res.columns, sql: res.sql });
    } catch {
      dropped++;
    }
  }

  if (!tiles.length) {
    await logAsk(user, question, spec, false, 'no_valid_tiles');
    return {
      clarify: lang === 'en'
        ? "I couldn't map that to the available data. Could you rephrase?"
        : 'Ich konnte das nicht auf die vorhandenen Daten abbilden. Kannst du es anders formulieren?',
      tiles: [], dropped,
    };
  }

  await logAsk(user, question, spec, true, null);
  return { title: spec.title, summary: spec.summary, chip, tiles, dropped };
}
