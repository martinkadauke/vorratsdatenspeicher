import { adminSql, DEMO_MODE } from '../db.js';

/** Anyone on the internet can create a demo household with one click, and every household is
 *  deleted within 24h — so a visitor must not be able to burn the operator's AI credit by
 *  looping the scanner, the category-designer chat, the categoriser or any of the other
 *  LLM-backed features (note that on demo a visitor IS is_admin of their own household, so
 *  requireAdmin is no protection at all — only requireOperator is).
 *
 *  These ceilings apply ONLY in DEMO_MODE; dev, stage, prod and every self-host install are
 *  completely unlimited (the counter columns don't even exist there — see
 *  migrations/demo/098_demo_limits.sql and 099_demo_ai_quota.sql).
 *
 *  Counters are CUMULATIVE. Counting live rows ("how many receipts exist") would not be a
 *  spend cap at all: deleting a receipt hands the slot back while the tokens stay spent. */
export const DEMO_MAX_OCR = 15;    // vision OCR runs: scan, attach photo, re-scan, mail import
export const DEMO_MAX_RECATS = 3;  // recategorisation runs
export const DEMO_MAX_CHAT = 20;   // category-designer chat turns
/** Catch-all for every OTHER visitor-reachable LLM call: the analytics + spending assistants,
 *  the offer web-search, the bank matcher, the AI bank-CSV format reader, the pay-slip vision
 *  extraction, the store web-search and the base-unit seeder. Deliberately ONE shared bucket
 *  instead of six columns — a demo household lives at most 24h, so "has this visitor had
 *  enough AI in total" is the only question worth accounting for. */
export const DEMO_MAX_AI = 40;

/** How many searched products ONE ai_count unit buys.
 *
 *  The offer search is a LOOP, not a single call: offers/index.ts walks every subscribed/watched
 *  product and can spend one LLM call on each of them (the SearXNG fallback fires whenever
 *  Marktguru has no ZIP or no hit). A flat "one unit per run" charge would therefore bound how
 *  often the button may be pressed while leaving the actual token spend unbounded — the product
 *  list is visitor-controlled, so 5000 watches would buy 5000 LLM calls for a single unit.
 *  Charging per BLOCK OF PRODUCTS makes the bucket bound the work instead of the clicks. */
export const DEMO_AI_PRODUCTS_PER_UNIT = 10;

/** Ceiling on the "watch" products one demo household may keep. Creating a watch costs nothing,
 *  but OWNING one is not free: it permanently enlarges every later offer run. The per-product
 *  charge above already prices the fan-out; this is the coarse sanity bound that keeps a scripted
 *  insert loop from filling the table in the first place. */
export const DEMO_MAX_WATCHES = 40;

/** Household 1 is the operator's own — never rate-limit yourself out of your own instance. */
const OPERATOR_HOUSEHOLD = 1;

export type Quota = 'ocr_count' | 'recat_count' | 'chat_count' | 'ai_count';
export interface Claim { ok: boolean; used: number; max: number; need: number }

/** Atomically claim `units` of a quota (default 1). The `UPDATE … WHERE counter + units <= max
 *  RETURNING` both checks and consumes in a single statement, so parallel requests cannot slip
 *  past the ceiling the way a read-then-write check would, and a multi-unit claim is all-or-
 *  nothing (never half-charged). For units = 1 the predicate is exactly the original
 *  `counter < max`, so every existing single-unit caller is unchanged.
 *  `household` carries no RLS, hence adminSql with an explicit id. */
export async function claimDemoQuota(householdId: number | null | undefined, quota: Quota, max: number, units = 1): Promise<Claim> {
  // Guard the arithmetic, not just the caller: a 0 or NaN "units" would otherwise turn the
  // atomic claim into a free pass that still reports ok.
  const need = Number.isFinite(units) ? Math.max(1, Math.trunc(units)) : 1;
  if (!DEMO_MODE) return { ok: true, used: 0, max, need };
  const hid = householdId ?? OPERATOR_HOUSEHOLD;
  if (hid === OPERATOR_HOUSEHOLD) return { ok: true, used: 0, max, need };
  const rows = await adminSql`
    UPDATE household SET ${adminSql(quota)} = ${adminSql(quota)} + ${need}
    WHERE id = ${hid} AND ${adminSql(quota)} + ${need} <= ${max}
    RETURNING ${adminSql(quota)} AS used`;
  if (rows.length) return { ok: true, used: rows[0].used as number, max, need };
  return { ok: false, used: max, max, need };
}

export const claimDemoOcr = (hid: number | null | undefined) => claimDemoQuota(hid, 'ocr_count', DEMO_MAX_OCR);
export const claimDemoRecat = (hid: number | null | undefined) => claimDemoQuota(hid, 'recat_count', DEMO_MAX_RECATS);
export const claimDemoChat = (hid: number | null | undefined) => claimDemoQuota(hid, 'chat_count', DEMO_MAX_CHAT);
export const claimDemoAi = (hid: number | null | undefined) => claimDemoQuota(hid, 'ai_count', DEMO_MAX_AI);
/** Multi-unit variant for the LOOPING features (offer search): charge in proportion to how much
 *  work the run will do, so the ceiling bounds tokens rather than button presses. */
export const claimDemoAiUnits = (hid: number | null | undefined, units: number) =>
  claimDemoQuota(hid, 'ai_count', DEMO_MAX_AI, units);

const tail = 'In der selbst gehosteten Version gibt es keine Begrenzung.';
export const ocrLimitMessage = (max: number) =>
  `Demo-Limit erreicht: maximal ${max} Belege pro Haushalt automatisch auslesen. ${tail}`;
export const recatLimitMessage = (max: number) =>
  `Demo-Limit erreicht: die Kategorisierung kann pro Haushalt maximal ${max}× neu berechnet werden. ${tail}`;
export const chatLimitMessage = (max: number) =>
  `Demo-Limit erreicht: maximal ${max} Nachrichten an den Kategorien-Assistenten. ${tail}`;
/** One message for the whole shared bucket — the user doesn't care which of the AI features
 *  used up the budget, only that the demo has an overall ceiling. */
export const aiLimitMessage = (max: number) =>
  `Demo-Limit erreicht: maximal ${max} KI-Aktionen pro Haushalt (Assistent, Angebotssuche, Bank-Zuordnung, Gehaltszettel …). ${tail}`;
/** A single run that is too big to ever fit in the bucket needs its OWN message: repeating
 *  "Limit erreicht" would send the user looking for a counter to wait out, when the fix is to
 *  shrink the run (fewer watched products). */
export const aiBurstLimitMessage = (need: number, max: number) =>
  `Demo-Limit: dieser Lauf würde ${need} von insgesamt ${max} KI-Aktionen auf einmal verbrauchen. Bitte weniger Produkte beobachten. ${tail}`;
export const watchLimitMessage = (max: number) =>
  `Demo-Limit erreicht: maximal ${max} beobachtete Produkte pro Haushalt. ${tail}`;
