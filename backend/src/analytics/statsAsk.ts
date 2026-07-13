// Statistics NL assistant. Unlike the (deprecated) Analytics agent — which built
// whole dashboards — this one has ONE narrow job: translate a natural-language
// question into the exact FILTERS the Statistik page already exposes to the user
// (a category, a date range, and a set of accounts). It never emits SQL and never
// emits a number: the frontend applies these filters and the deterministic
// /api/spending endpoints compute every figure. So the worst a bad model can do
// is pick a wrong-but-valid category or range — never a hallucinated amount.

import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { providerForTask } from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';
import type { User } from '../types.js';

export interface StatsAskResult {
  category_path: string | null;
  category_label: string | null;
  from: string | null;
  to: string | null;
  konto_ids: number[];
  answer: string | null;   // short neutral restatement, no numbers
  clarify: string | null;  // set when the question could not be mapped
}

interface RawSpec {
  category_path?: string | null;
  from?: string | null;
  to?: string | null;
  konto_ids?: number[] | null;
  answer?: string | null;
  clarify?: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function empty(clarify: string | null): StatsAskResult {
  return { category_path: null, category_label: null, from: null, to: null, konto_ids: [], answer: null, clarify };
}

function systemPrompt(lang: string, catList: string, kontoList: string): string {
  const L = lang === 'en';
  return `${L ? 'You are the Statistik assistant of VDS, a household finance & spending tracker.' : 'Du bist der Statistik-Assistent von VDS, einem Haushalts-Finanz- und Ausgaben-Tracker.'}
${L
  ? 'Your ONLY job is to translate the question into FILTERS the UI already exposes: a category, a date range, and accounts. You NEVER compute or state a number — the app calculates everything from the chosen filters.'
  : 'Deine EINZIGE Aufgabe: die Frage in FILTER übersetzen, die die Oberfläche ohnehin anbietet: eine Kategorie, einen Datumsbereich und Konten. Du berechnest oder nennst NIEMALS eine Zahl — die App rechnet alles aus den gewählten Filtern.'}

${L ? 'HARD RULES:' : 'HARTE REGELN:'}
- ${L ? 'Pick "category_path" EXACTLY from the list below (or null if the question is not about one specific category).' : 'Wähle "category_path" EXAKT aus der Liste unten (oder null, wenn es nicht um eine bestimmte Kategorie geht).'}
- ${L ? 'Map article/product words to the category they belong to (e.g. "fruit"/"bananas" -> the fruit category, "petrol" -> the fuel category).' : 'Bilde Artikel-/Produktwörter auf ihre Kategorie ab (z. B. "Obst"/"Bananen" -> die Obst-Kategorie, "Benzin" -> die Sprit-Kategorie).'}
- ${L ? 'from/to are inclusive ISO dates YYYY-MM-DD. Give BOTH or neither. Resolve relative periods ("May to July", "last 3 months") using today\'s date. If no period is stated, leave both null (the UI keeps its current month).' : 'from/to sind inklusive ISO-Daten YYYY-MM-DD. Gib BEIDE oder keins. Löse relative Zeiträume ("Mai bis Juli", "letzte 3 Monate") mit dem heutigen Datum auf. Ohne Zeitangabe lass beide null (die Oberfläche behält ihren aktuellen Monat).'}
- ${L ? 'konto_ids: pick account ids from the list only if the question names an account; otherwise null.' : 'konto_ids: nur Konto-IDs aus der Liste, wenn die Frage ein Konto nennt; sonst null.'}
- ${L ? '"answer": ONE short neutral sentence restating what will be shown, WITHOUT any number.' : '"answer": EIN kurzer neutraler Satz, der beschreibt was gezeigt wird, OHNE jede Zahl.'}
- ${L ? 'If the question cannot be mapped to these filters, set "clarify" to a short follow-up and leave the rest null.' : 'Lässt sich die Frage nicht auf diese Filter abbilden, setze "clarify" auf eine kurze Rückfrage und lass den Rest null.'}

${L ? 'CATEGORIES (use the exact path on the left):' : 'KATEGORIEN (nutze den exakten Pfad links):'}
${catList}

${L ? 'ACCOUNTS:' : 'KONTEN:'}
${kontoList}

${L ? 'Answer with EXACTLY this JSON, nothing around it:' : 'Antworte mit GENAU diesem JSON, ohne Text drumherum:'}
{"category_path": null, "from": null, "to": null, "konto_ids": null, "answer": "...", "clarify": null}`;
}

export async function askStats(question: string, user: User | undefined, lang = 'de'): Promise<StatsAskResult> {
  const cats = await sql`
    SELECT path, display, display_en FROM category
    WHERE COALESCE(is_meta, false) = false
    ORDER BY sort_order, path`;
  const konten = await sql`SELECT id, name FROM konto ORDER BY sort_order, id`;
  const ks = kontoScope(user, sql`t`);
  const [range] = await sql`
    SELECT to_char(MIN(datum), 'YYYY-MM-DD') AS lo, to_char(MAX(datum), 'YYYY-MM-DD') AS hi
    FROM v_transactions t WHERE TRUE ${ks}`;
  const today = new Date().toISOString().slice(0, 10);

  const labelOf = new Map(cats.map(c => [c.path as string, (lang === 'en' && c.display_en ? c.display_en : c.display) as string]));
  const validPaths = new Set(cats.map(c => c.path as string));
  const validKonten = new Set(konten.map(k => Number(k.id)));

  const catList = cats.map(c => `  - ${c.path}  (${labelOf.get(c.path as string)})`).join('\n');
  const kontoList = konten.map(k => `  - ${k.id}: ${k.name}`).join('\n') || '  —';

  const provider = await providerForTask('nlanalytics');
  const userMsg = `${lang === 'en' ? 'Today' : 'Heute'}: ${today}. ${lang === 'en' ? 'Data range' : 'Datenbereich'}: ${range?.lo ?? '—'} … ${range?.hi ?? '—'}.\n${lang === 'en' ? 'Question' : 'Frage'}: "${question}"`;

  let raw: string;
  try {
    raw = await provider.chat({ system: systemPrompt(lang, catList, kontoList), user: userMsg, json: true });
  } catch {
    return empty(lang === 'en' ? 'The assistant is unavailable right now.' : 'Der Assistent ist gerade nicht erreichbar.');
  }

  let spec: RawSpec;
  try {
    spec = parseLlmJson<RawSpec>(raw);
  } catch {
    return empty(lang === 'en' ? "I couldn't interpret that. Try e.g. \"fruit from May to July\"." : 'Das konnte ich nicht deuten. Versuch z. B. „Obst von Mai bis Juli".');
  }

  if (spec.clarify && String(spec.clarify).trim()) return empty(String(spec.clarify).trim());

  const category_path = spec.category_path && validPaths.has(spec.category_path) ? spec.category_path : null;
  const fromOk = typeof spec.from === 'string' && ISO.test(spec.from);
  const toOk = typeof spec.to === 'string' && ISO.test(spec.to);
  // Only a valid range when both ends parse and are ordered — otherwise no range.
  const hasRange = fromOk && toOk && (spec.from as string) <= (spec.to as string);
  const konto_ids = Array.isArray(spec.konto_ids)
    ? [...new Set(spec.konto_ids.map(Number).filter(n => validKonten.has(n)))]
    : [];
  const answer = typeof spec.answer === 'string' && spec.answer.trim() ? spec.answer.trim() : null;

  return {
    category_path,
    category_label: category_path ? (labelOf.get(category_path) ?? null) : null,
    from: hasRange ? (spec.from as string) : null,
    to: hasRange ? (spec.to as string) : null,
    konto_ids,
    answer,
    clarify: null,
  };
}
