import sql from '../db.js';
import { recordAliases } from './canonicalAlias.js';

/**
 * Apply a human-confirmed canonical name to a set of articles — the single
 * learning event behind the Prüfen page.
 *
 * Sets the name + `user_corrected`, learns an AUTHORITATIVE (user_confirmed)
 * alias for each article's OCR text (so the next scan resolves it deterministically
 * with no AI), and supersedes any pending churner proposals for those articles so
 * stale Prüfen rows can't linger. Returns the number of articles updated.
 */
export async function applyCanonicalToArticles(artikelIds: number[], canonical: string): Promise<number> {
  const ids = artikelIds.filter(n => Number.isInteger(n));
  const canon = canonical.trim();
  if (!ids.length || !canon) return 0;

  const updated = await sql.begin(async tx => {
    const rows = await tx`
      UPDATE artikel SET canonical_name = ${canon}, user_corrected = TRUE
      WHERE id IN ${tx(ids)}
      RETURNING original_text, name
    `;
    await tx`
      UPDATE verifikations_queue SET status = 'superseded'
      WHERE status = 'pending' AND artikel_id IN ${tx(ids)}
    `;
    return rows;
  });

  await recordAliases(updated.map(r => [(r.original_text as string) ?? (r.name as string), canon]), true);
  return updated.length;
}
