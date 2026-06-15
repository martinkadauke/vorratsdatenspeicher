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
interface AgentSpec { clarify?: string | null; title?: string; summary?: string; tiles?: SpecTile[] }

export interface DashboardTile {
  type: TileType; title: string;
  rows: AnalyticsResult['rows']; columns: AnalyticsResult['columns']; sql: string;
}
export interface AskResult {
  clarify?: string | null;
  title?: string;
  summary?: string;
  tiles: DashboardTile[];
  dropped: number;
}

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

Vorzeichen: Ausgaben negativ, Einnahmen positiv. Metrik "spend" = positive Ausgabensumme, "income" = positive Einnahmen, "net" = Saldo (Einnahmen − Ausgaben).

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

Antworte mit GENAU diesem JSON (keine Erklärung drumherum):
{"clarify": null, "title": "...", "summary": "...", "tiles": [{"type":"kpi","title":"...","query":{"metric":"spend","grain":"month","dimensions":["category"],"filters":{"from":"2026-01-01"},"limit":12}}]}

Sprache der Texte (title/summary/clarify): ${lang === 'en' ? 'Englisch' : 'Deutsch'}. Baue 1–5 sinnvolle, sich ergänzende Tiles (z.B. KPI-Summe + Zeitreihe + Breakdown).`;
}

interface Ctx { today: string; lo: string | null; hi: string | null; categories: string[]; konten: string[] }

function userPrompt(question: string, ctx: Ctx): string {
  return `Heute: ${ctx.today}. Verfügbarer Datenbereich: ${ctx.lo ?? '—'} bis ${ctx.hi ?? '—'}.
Oberste Kategorien: ${ctx.categories.join(', ') || '—'}.
Konten: ${ctx.konten.join(', ') || '—'}.

Frage: "${question}"`;
}

async function loadContext(user: User | undefined): Promise<Ctx> {
  const ks = kontoScope(user, sql`t.konto_id`);
  const [range] = await sql`
    SELECT to_char(MIN(datum), 'YYYY-MM-DD') AS lo, to_char(MAX(datum), 'YYYY-MM-DD') AS hi
    FROM v_transactions t WHERE TRUE ${ks}`;
  const cats = await sql`SELECT display FROM category WHERE level = 1 ORDER BY sort_order, display`;
  const konten = user?.sees_all_konten
    ? await sql`SELECT name FROM konto ORDER BY sort_order, id`
    : await sql`SELECT name FROM konto WHERE is_shared = TRUE OR user_id = ${user?.id ?? -1} ORDER BY sort_order, id`;
  return {
    today: new Date().toISOString().slice(0, 10),
    lo: (range?.lo as string | null) ?? null,
    hi: (range?.hi as string | null) ?? null,
    categories: cats.map(c => c.display as string),
    konten: konten.map(k => k.name as string),
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

export async function askAnalytics(question: string, user: User | undefined, lang = 'de'): Promise<AskResult> {
  const ctx = await loadContext(user);
  const provider = await providerForTask('nlanalytics');
  const raw = await provider.chat({ system: systemPrompt(lang), user: userPrompt(question, ctx), json: true });

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

  if (spec.clarify) {
    await logAsk(user, question, spec, true, null);
    return { clarify: spec.clarify, tiles: [], dropped: 0 };
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
  return { title: spec.title, summary: spec.summary, tiles, dropped };
}
