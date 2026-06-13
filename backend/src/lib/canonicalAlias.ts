// Learned OCR→canonical alias memory. The cheapest, most reliable tier: if the
// exact (normalized) raw OCR text was ever mapped to a canonical name, reuse it.
// Populated from every assignment — matcher, churner LLM, or manual correction —
// so the system learns over time.
import sql from '../db.js';

/** Normalize raw OCR text to a stable alias key: accent/case-folded, prices &
 *  quantities/units removed, punctuation collapsed. "BIO BANAN. 1,99" → "bio banan". */
export function ocrKey(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\d+[.,]\d{2}\b/g, ' ')                                   // prices 1,99
    .replace(/\b\d+\s?(x|stk|stück|st|g|kg|ml|l|cl|pkg|pack)\b/gi, ' ') // 6x, 500g, 1,5l …
    .replace(/[^a-z0-9äöüß]+/g, ' ')                                    // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remember that an OCR text maps to a canonical (idempotent, reinforcing).
 *  `userConfirmed` = the mapping came from a manual user correction → it becomes
 *  authoritative: a later AI/matcher write can NOT overwrite it (only another user
 *  correction can). */
export async function recordAlias(
  text: string | null | undefined,
  canonical: string | null | undefined,
  userConfirmed = false,
): Promise<void> {
  const key = ocrKey(text);
  const canon = (canonical ?? '').trim();
  if (key.length < 2 || !canon) return;
  try {
    await sql`
      INSERT INTO canonical_alias (ocr_key, canonical_name, count, user_confirmed, updated_at)
      VALUES (${key}, ${canon}, 1, ${userConfirmed}, NOW())
      ON CONFLICT (ocr_key) DO UPDATE
        SET canonical_name = CASE
              WHEN ${userConfirmed} OR NOT canonical_alias.user_confirmed THEN EXCLUDED.canonical_name
              ELSE canonical_alias.canonical_name END,
            user_confirmed = canonical_alias.user_confirmed OR ${userConfirmed},
            count = canonical_alias.count + 1, updated_at = NOW()
    `;
  } catch { /* alias learning is best-effort */ }
}

/** Record many at once (e.g. all items of a freshly OCR'd receipt). */
export async function recordAliases(
  pairs: [string | null | undefined, string | null | undefined][],
  userConfirmed = false,
): Promise<void> {
  for (const [t, c] of pairs) await recordAlias(t, c, userConfirmed);
}

/** Load the whole alias table as a Map for fast in-memory lookup during a run. */
export async function loadAliasMap(): Promise<Map<string, string>> {
  const rows = await sql`SELECT ocr_key, canonical_name FROM canonical_alias`;
  return new Map(rows.map(r => [r.ocr_key as string, r.canonical_name as string]));
}

/** User-confirmed aliases only — fed to the churner LLM as a strong prior. */
export async function loadUserAliases(): Promise<{ key: string; canonical: string }[]> {
  const rows = await sql`SELECT ocr_key, canonical_name FROM canonical_alias WHERE user_confirmed = TRUE`;
  return rows.map(r => ({ key: r.ocr_key as string, canonical: r.canonical_name as string }));
}

/** Set of OCR keys that carry a user-confirmed alias — used to flag artikel whose
 *  canonical was inherited from a manual correction as "Nutzerkorrigiert". */
export async function loadUserAliasKeys(): Promise<Set<string>> {
  const rows = await sql`SELECT ocr_key FROM canonical_alias WHERE user_confirmed = TRUE`;
  return new Set(rows.map(r => r.ocr_key as string));
}

/** One-time backfill from existing assignments (runs only if the table is empty),
 *  picking the most-frequent canonical per OCR key. */
export async function backfillAliases(): Promise<void> {
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM canonical_alias`;
  if (n > 0) return;
  const rows = await sql`
    SELECT original_text, canonical_name, COUNT(*)::int AS c
    FROM artikel
    WHERE canonical_name IS NOT NULL AND original_text IS NOT NULL AND original_text <> ''
    GROUP BY original_text, canonical_name
  `;
  const byKey = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = ocrKey(r.original_text as string);
    if (key.length < 2) continue;
    const m = byKey.get(key) ?? new Map<string, number>();
    m.set(r.canonical_name as string, (m.get(r.canonical_name as string) ?? 0) + (r.c as number));
    byKey.set(key, m);
  }
  let added = 0;
  for (const [key, m] of byKey) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    await sql`
      INSERT INTO canonical_alias (ocr_key, canonical_name, count, updated_at)
      VALUES (${key}, ${best}, 1, NOW()) ON CONFLICT (ocr_key) DO NOTHING
    `;
    added++;
  }
  console.log(`[alias] backfilled ${added} OCR→canonical aliases`);
}
