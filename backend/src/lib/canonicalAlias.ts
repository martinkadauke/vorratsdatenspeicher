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

/** Remember that an OCR text maps to a canonical (idempotent, reinforcing). */
export async function recordAlias(text: string | null | undefined, canonical: string | null | undefined): Promise<void> {
  const key = ocrKey(text);
  const canon = (canonical ?? '').trim();
  if (key.length < 2 || !canon) return;
  try {
    await sql`
      INSERT INTO canonical_alias (ocr_key, canonical_name, count, updated_at)
      VALUES (${key}, ${canon}, 1, NOW())
      ON CONFLICT (ocr_key) DO UPDATE
        SET canonical_name = EXCLUDED.canonical_name,
            count = canonical_alias.count + 1, updated_at = NOW()
    `;
  } catch { /* alias learning is best-effort */ }
}

/** Record many at once (e.g. all items of a freshly OCR'd receipt). */
export async function recordAliases(pairs: [string | null | undefined, string | null | undefined][]): Promise<void> {
  for (const [t, c] of pairs) await recordAlias(t, c);
}

/** Load the whole alias table as a Map for fast in-memory lookup during a run. */
export async function loadAliasMap(): Promise<Map<string, string>> {
  const rows = await sql`SELECT ocr_key, canonical_name FROM canonical_alias`;
  return new Map(rows.map(r => [r.ocr_key as string, r.canonical_name as string]));
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
