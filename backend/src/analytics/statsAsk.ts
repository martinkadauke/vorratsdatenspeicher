// Statistics NL assistant. Unlike the (deprecated) Analytics agent — which built
// whole dashboards — this one has ONE narrow job: translate a natural-language
// question into the exact FILTERS the Statistik page already exposes to the user:
//   • a category (path), OR a set of articles (canonical names) for a concept that
//     is not a category (e.g. "fuel" = Diesel + Benzin, which live in Uncategorised),
//   • a date range, and a set of accounts.
// It never emits SQL and never emits a number: the frontend applies these filters and
// the deterministic /api/spending endpoints compute every figure. So the worst a bad
// model can do is pick wrong-but-valid articles/category/range — never a hallucinated
// amount. Runs on its own configurable AI task ('statsask', defaults to DeepSeek).

import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { providerForTask } from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';
import type { User } from '../types.js';

export interface StatsAskResult {
  category_path: string | null;
  category_label: string | null;
  canonicals: string[];        // article scope: a concept spanning ≥1 article (wins over category)
  group_label: string | null;  // human label for the article group, e.g. "Kraftstoff"
  from: string | null;
  to: string | null;
  konto_ids: number[];
  answer: string | null;   // short neutral restatement, no numbers
  clarify: string | null;  // set when the question could not be mapped
}

interface RawSpec {
  category_path?: string | null;
  canonicals?: string[] | null;
  group_label?: string | null;
  from?: string | null;
  to?: string | null;
  konto_ids?: number[] | null;
  answer?: string | null;
  clarify?: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function empty(clarify: string | null): StatsAskResult {
  return { category_path: null, category_label: null, canonicals: [], group_label: null, from: null, to: null, konto_ids: [], answer: null, clarify };
}

function systemPrompt(lang: string, catList: string, artList: string, kontoList: string): string {
  const L = lang === 'en';
  return `${L ? 'You are the Statistik assistant of VDS, a household finance & spending tracker.' : 'Du bist der Statistik-Assistent von VDS, einem Haushalts-Finanz- und Ausgaben-Tracker.'}
${L
  ? 'Your ONLY job is to translate the question into FILTERS the UI already exposes: a category OR a set of articles, a date range, and accounts. You NEVER compute or state a number — the app calculates everything from the chosen filters.'
  : 'Deine EINZIGE Aufgabe: die Frage in FILTER übersetzen, die die Oberfläche ohnehin anbietet: eine Kategorie ODER eine Menge von Artikeln, einen Datumsbereich und Konten. Du berechnest oder nennst NIEMALS eine Zahl — die App rechnet alles aus den gewählten Filtern.'}

${L ? 'HARD RULES:' : 'HARTE REGELN:'}
- ${L ? 'CATEGORY vs ARTICLES: if a real category fits the question, set "category_path" EXACTLY from the CATEGORIES list. If the question is about specific products or a concept that is NOT a category — especially one spanning several articles (e.g. "fuel" = Diesel + Benzin + AdBlue, "snacks", "coffee") — instead set "canonicals" to the EXACT article names from the ARTICLES list that belong to it, and leave category_path null.' : 'KATEGORIE vs ARTIKEL: Passt eine echte Kategorie zur Frage, setze "category_path" EXAKT aus der KATEGORIEN-Liste. Geht es um konkrete Produkte oder einen Begriff, der KEINE Kategorie ist — besonders einen, der mehrere Artikel umfasst (z. B. "Kraftstoff"/"Sprit" = Diesel + Benzin + AdBlue, "Snacks", "Kaffee") — setze stattdessen "canonicals" auf die EXAKTEN Artikelnamen aus der ARTIKEL-Liste, die dazugehören, und lass category_path null.'}
- ${L ? 'Only use names that appear VERBATIM in the ARTICLES list. Never invent an article. If nothing fits, leave canonicals empty.' : 'Verwende nur Namen, die WORTWÖRTLICH in der ARTIKEL-Liste stehen. Erfinde nie einen Artikel. Passt nichts, lass canonicals leer.'}
- ${L ? '"group_label": a short human label for the article group (e.g. "Fuel"), or null when canonicals is empty.' : '"group_label": ein kurzes Label für die Artikelgruppe (z. B. "Kraftstoff"), oder null wenn canonicals leer ist.'}
- ${L ? 'from/to are inclusive ISO dates YYYY-MM-DD. Give BOTH or neither. Resolve relative periods ("May to July", "last 3 months", "in 2026") using today\'s date. If no period is stated, leave both null (the UI keeps its current month).' : 'from/to sind inklusive ISO-Daten YYYY-MM-DD. Gib BEIDE oder keins. Löse relative Zeiträume ("Mai bis Juli", "letzte 3 Monate", "in 2026") mit dem heutigen Datum auf. Ohne Zeitangabe lass beide null (die Oberfläche behält ihren aktuellen Monat).'}
- ${L ? 'konto_ids: pick account ids from the list only if the question names an account; otherwise null.' : 'konto_ids: nur Konto-IDs aus der Liste, wenn die Frage ein Konto nennt; sonst null.'}
- ${L ? '"answer": ONE short neutral sentence restating what will be shown, WITHOUT any number.' : '"answer": EIN kurzer neutraler Satz, der beschreibt was gezeigt wird, OHNE jede Zahl.'}
- ${L ? 'If the question cannot be mapped at all, set "clarify" to a short follow-up and leave the rest null.' : 'Lässt sich die Frage gar nicht abbilden, setze "clarify" auf eine kurze Rückfrage und lass den Rest null.'}

${L ? 'CATEGORIES (use the exact path on the left):' : 'KATEGORIEN (nutze den exakten Pfad links):'}
${catList}

${L ? 'ARTICLES (exact canonical names you have bought):' : 'ARTIKEL (exakte kanonische Namen, die gekauft wurden):'}
${artList}

${L ? 'ACCOUNTS:' : 'KONTEN:'}
${kontoList}

${L ? 'Answer with EXACTLY this JSON, nothing around it:' : 'Antworte mit GENAU diesem JSON, ohne Text drumherum:'}
{"category_path": null, "canonicals": [], "group_label": null, "from": null, "to": null, "konto_ids": null, "answer": "...", "clarify": null}`;
}

export async function askStats(question: string, user: User | undefined, lang = 'de'): Promise<StatsAskResult> {
  const cats = await sql`
    SELECT path, display, display_en FROM category
    WHERE COALESCE(is_meta, false) = false
    ORDER BY sort_order, path`;
  // The article vocabulary = canonical names actually purchased (so the model can map
  // a concept like "fuel" onto the real "Diesel"/"Benzin" articles that exist).
  const arts = await sql`
    SELECT DISTINCT canonical_name FROM artikel
    WHERE canonical_name IS NOT NULL AND canonical_name <> ''
    ORDER BY canonical_name`;
  const konten = await sql`SELECT id, name FROM konto ORDER BY sort_order, id`;
  const ks = kontoScope(user, sql`t`);
  const [range] = await sql`
    SELECT to_char(MIN(datum), 'YYYY-MM-DD') AS lo, to_char(MAX(datum), 'YYYY-MM-DD') AS hi
    FROM v_transactions t WHERE TRUE ${ks}`;
  const today = new Date().toISOString().slice(0, 10);

  const labelOf = new Map(cats.map(c => [c.path as string, (lang === 'en' && c.display_en ? c.display_en : c.display) as string]));
  const validPaths = new Set(cats.map(c => c.path as string));
  const validKonten = new Set(konten.map(k => Number(k.id)));
  const validArts = new Set(arts.map(a => a.canonical_name as string));

  const catList = cats.map(c => `  - ${c.path}  (${labelOf.get(c.path as string)})`).join('\n');
  const artList = arts.map(a => `  - ${a.canonical_name}`).join('\n') || '  —';
  const kontoList = konten.map(k => `  - ${k.id}: ${k.name}`).join('\n') || '  —';

  const userMsg = `${lang === 'en' ? 'Today' : 'Heute'}: ${today}. ${lang === 'en' ? 'Data range' : 'Datenbereich'}: ${range?.lo ?? '—'} … ${range?.hi ?? '—'}.\n${lang === 'en' ? 'Question' : 'Frage'}: "${question}"`;

  // Provider construction can throw (e.g. a task configured for a provider whose API
  // key is unset) — keep it inside the guard so an outage becomes a graceful
  // "unavailable" clarify, never a 500.
  let raw: string;
  try {
    const provider = await providerForTask('statsask');
    raw = await provider.chat({ system: systemPrompt(lang, catList, artList, kontoList), user: userMsg, json: true });
  } catch {
    return empty(lang === 'en' ? 'The assistant is unavailable right now.' : 'Der Assistent ist gerade nicht erreichbar.');
  }

  let spec: RawSpec;
  try {
    spec = parseLlmJson<RawSpec>(raw);
  } catch {
    return empty(lang === 'en' ? "I couldn't interpret that. Try e.g. \"fuel in 2026\"." : 'Das konnte ich nicht deuten. Versuch z. B. „Kraftstoff in 2026".');
  }
  // parseLlmJson("null")/("42")/("[]") return valid JSON that is not an object;
  // property access below would throw, so bail out gracefully.
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return empty(lang === 'en' ? "I couldn't interpret that. Try e.g. \"fuel in 2026\"." : 'Das konnte ich nicht deuten. Versuch z. B. „Kraftstoff in 2026".');
  }

  if (spec.clarify && String(spec.clarify).trim()) return empty(String(spec.clarify).trim());

  // Article scope wins over category. Keep only names that really exist (dedup, cap 40).
  const canonicals = Array.isArray(spec.canonicals)
    ? [...new Set(spec.canonicals.filter(n => typeof n === 'string' && validArts.has(n)))].slice(0, 40)
    : [];
  const category_path = canonicals.length === 0 && spec.category_path && validPaths.has(spec.category_path) ? spec.category_path : null;
  const group_label = canonicals.length > 0 && typeof spec.group_label === 'string' && spec.group_label.trim()
    ? spec.group_label.trim().slice(0, 40)
    : null;

  const fromOk = typeof spec.from === 'string' && ISO.test(spec.from);
  const toOk = typeof spec.to === 'string' && ISO.test(spec.to);
  // Only a valid range when both ends parse and are ordered — otherwise no range.
  const hasRange = fromOk && toOk && (spec.from as string) <= (spec.to as string);
  const konto_ids = Array.isArray(spec.konto_ids)
    ? [...new Set(spec.konto_ids.map(Number).filter(n => validKonten.has(n)))]
    : [];
  // The assistant must never state a figure — the UI computes every number. If the
  // model slips a currency amount into its restatement anyway, drop the sentence
  // and fall back to the generic "filters applied" label. Small ordinals inside
  // relative periods ("3 Monate", "6 Wochen") are fine, so only amounts are caught:
  // a currency symbol/word, a decimal amount, or a run of 3+ digits.
  const rawAnswer = typeof spec.answer === 'string' && spec.answer.trim() ? spec.answer.trim() : null;
  const looksLikeAmount = rawAnswer !== null && /[€$]|\beur\b|\d[.,]\d{2}\b|\d{3,}/i.test(rawAnswer);
  const answer = rawAnswer && !looksLikeAmount ? rawAnswer : null;

  return {
    category_path,
    category_label: category_path ? (labelOf.get(category_path) ?? null) : null,
    canonicals,
    group_label,
    from: hasRange ? (spec.from as string) : null,
    to: hasRange ? (spec.to as string) : null,
    konto_ids,
    answer,
    clarify: null,
  };
}
