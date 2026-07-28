import { adminSql, DEMO_MODE } from '../db.js';

/** Anyone on the internet can create a demo household with one click, and every household is
 *  deleted within 24h — so a visitor must not be able to burn the operator's AI credit by
 *  looping the scanner, the category-designer chat or the categoriser.
 *
 *  These ceilings apply ONLY in DEMO_MODE; dev, stage, prod and every self-host install are
 *  completely unlimited (the counter columns don't even exist there — see
 *  migrations/demo/098_demo_limits.sql).
 *
 *  Counters are CUMULATIVE. Counting live rows ("how many receipts exist") would not be a
 *  spend cap at all: deleting a receipt hands the slot back while the tokens stay spent. */
export const DEMO_MAX_OCR = 15;    // vision OCR runs: scan, attach photo, re-scan, mail import
export const DEMO_MAX_RECATS = 3;  // recategorisation runs
export const DEMO_MAX_CHAT = 20;   // category-designer chat turns

/** Household 1 is the operator's own — never rate-limit yourself out of your own instance. */
const OPERATOR_HOUSEHOLD = 1;

export type Quota = 'ocr_count' | 'recat_count' | 'chat_count';
export interface Claim { ok: boolean; used: number; max: number }

/** Atomically claim one unit of a quota. The `UPDATE … WHERE counter < max RETURNING` both
 *  checks and consumes in a single statement, so parallel requests cannot slip past the
 *  ceiling the way a read-then-write check would. `household` carries no RLS, hence adminSql
 *  with an explicit id. */
export async function claimDemoQuota(householdId: number | null | undefined, quota: Quota, max: number): Promise<Claim> {
  if (!DEMO_MODE) return { ok: true, used: 0, max };
  const hid = householdId ?? OPERATOR_HOUSEHOLD;
  if (hid === OPERATOR_HOUSEHOLD) return { ok: true, used: 0, max };
  const rows = await adminSql`
    UPDATE household SET ${adminSql(quota)} = ${adminSql(quota)} + 1
    WHERE id = ${hid} AND ${adminSql(quota)} < ${max}
    RETURNING ${adminSql(quota)} AS used`;
  if (rows.length) return { ok: true, used: rows[0].used as number, max };
  return { ok: false, used: max, max };
}

export const claimDemoOcr = (hid: number | null | undefined) => claimDemoQuota(hid, 'ocr_count', DEMO_MAX_OCR);
export const claimDemoRecat = (hid: number | null | undefined) => claimDemoQuota(hid, 'recat_count', DEMO_MAX_RECATS);
export const claimDemoChat = (hid: number | null | undefined) => claimDemoQuota(hid, 'chat_count', DEMO_MAX_CHAT);

const tail = 'In der selbst gehosteten Version gibt es keine Begrenzung.';
export const ocrLimitMessage = (max: number) =>
  `Demo-Limit erreicht: maximal ${max} Belege pro Haushalt automatisch auslesen. ${tail}`;
export const recatLimitMessage = (max: number) =>
  `Demo-Limit erreicht: die Kategorisierung kann pro Haushalt maximal ${max}× neu berechnet werden. ${tail}`;
export const chatLimitMessage = (max: number) =>
  `Demo-Limit erreicht: maximal ${max} Nachrichten an den Kategorien-Assistenten. ${tail}`;
