import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { ocrKey, recordAliases } from '../lib/canonicalAlias.js';

interface QueueRow {
  id: number;
  proposed_canonical: string | null;
  ai_examples: string | null;
  raw_patterns: string | null;
  artikel_id: number | null;
}

/**
 * Approve one queue entry — and TEACH the system, which the old approve never did.
 *
 * 1. Resolve the entry's OCR key (from its article's stored ocr_key, else recomputed).
 * 2. Apply `canonical` to every article sharing that ocr_key that a human hasn't
 *    already decided (`user_corrected = FALSE`) — one decision heals all occurrences.
 *    Falls back to the legacy ai_examples match when no usable key is available.
 * 3. Record an AUTHORITATIVE (user_confirmed) alias for each healed OCR text, so the
 *    next scan resolves it deterministically with no AI.
 * 4. Close this row and supersede any sibling pending rows for the same article, so
 *    stale duplicates can't pile up the way the 117 did.
 * Returns the number of articles updated.
 */
async function approveQueueItem(item: QueueRow, canonical: string): Promise<number> {
  let key = '';
  if (item.artikel_id) {
    const [art] = await sql`SELECT ocr_key, original_text, name FROM artikel WHERE id = ${item.artikel_id}`;
    key = (art?.ocr_key as string) || ocrKey((art?.original_text as string) ?? (art?.name as string) ?? '');
  }
  if (!key) key = ocrKey(item.raw_patterns ?? item.ai_examples ?? '');

  const updated = await sql.begin(async tx => {
    let rows: { original_text: string | null; name: string | null }[] = [];
    if (key.length >= 2) {
      rows = await tx`
        UPDATE artikel SET canonical_name = ${canonical}, user_corrected = TRUE
        WHERE ocr_key = ${key} AND user_corrected = FALSE
        RETURNING original_text, name
      `;
    }
    if (!rows.length) {
      // Legacy fallback: match by the AI guess, only filling empty canonicals.
      rows = await tx`
        UPDATE artikel SET canonical_name = ${canonical}, user_corrected = TRUE
        WHERE canonical_name IS NULL AND NOT is_refund
          AND COALESCE(NULLIF(ai_guess, ''), name) = ${item.ai_examples}
        RETURNING original_text, name
      `;
    }
    await tx`UPDATE verifikations_queue SET status = 'approved' WHERE id = ${item.id}`;
    if (item.artikel_id) {
      await tx`
        UPDATE verifikations_queue SET status = 'superseded'
        WHERE status = 'pending' AND artikel_id = ${item.artikel_id} AND id <> ${item.id}
      `;
    }
    return rows;
  });

  await recordAliases(updated.map(r => [r.original_text ?? r.name, canonical]), true);
  return updated.length;
}

export function queueRoutes(app: FastifyInstance): void {
  app.get('/api/queue', async (req) => {
    const fq = req.query as { q?: string; sort?: string };
    const search = fq.q?.trim() ?? '';
    const like = search ? `%${search}%` : null;
    const searchCond = like
      ? sql`AND (q.proposed_canonical ILIKE ${like} OR q.raw_patterns ILIKE ${like} OR q.ai_examples ILIKE ${like})`
      : sql``;
    const order =
      fq.sort === 'confidence_desc' ? sql`ORDER BY q.confidence::numeric DESC NULLS LAST, q.created_at ASC`
      : fq.sort === 'date' ? sql`ORDER BY q.created_at DESC`
      : fq.sort === 'alpha' ? sql`ORDER BY q.proposed_canonical ASC NULLS LAST`
      : sql`ORDER BY q.confidence::numeric ASC NULLS FIRST, q.created_at ASC`; // default: most-uncertain first
    const items = await sql`
      SELECT q.id, q.proposed_canonical, q.raw_patterns, q.ai_examples, q.confidence,
             q.status, q.created_at,
             COALESCE(q.artikel_id, fb.artikel_id) AS artikel_id,
             COALESCE(a.einkauf_id, fb.einkauf_id) AS einkauf_id
      FROM verifikations_queue q
      LEFT JOIN artikel a ON a.id = q.artikel_id
      LEFT JOIN einkauf e ON e.id = a.einkauf_id
      -- Fallback for entries without a direct artikel_id: find the latest matching
      -- purchase by its parsed name (same match the approve step uses) so the
      -- receipt link still works.
      LEFT JOIN LATERAL (
        SELECT a2.id AS artikel_id, a2.einkauf_id
        FROM artikel a2 JOIN einkauf e2 ON e2.id = a2.einkauf_id
        WHERE q.artikel_id IS NULL AND q.ai_examples IS NOT NULL
          AND COALESCE(NULLIF(a2.ai_guess, ''), a2.name) = q.ai_examples
          ${kontoScope(req.user, sql`e2`)}
        ORDER BY e2.datum DESC, a2.id DESC
        LIMIT 1
      ) fb ON TRUE
      WHERE q.status = 'pending' ${searchCond}
        ${kontoScope(req.user, sql`e`)}
      ${order}
      LIMIT 200
    `;
    const [{ total }] = await sql`
      SELECT COUNT(*)::int AS total
      FROM verifikations_queue q
      LEFT JOIN artikel a ON a.id = q.artikel_id
      LEFT JOIN einkauf e ON e.id = a.einkauf_id
      WHERE q.status = 'pending'
        ${kontoScope(req.user, sql`e`)}
    `;
    return { items, total };
  });

  app.post('/api/queue/decide', async (req, reply) => {
    const { id, action, final_canonical } = (req.body ?? {}) as {
      id?: number; action?: string; final_canonical?: string;
    };
    if (!id || !action) return reply.code(400).send({ error: 'id and action required' });

    const items = await sql`SELECT id, proposed_canonical, ai_examples, raw_patterns, artikel_id FROM verifikations_queue WHERE id = ${id}`;
    if (!items.length) return reply.code(404).send({ error: 'not found' });
    const item = items[0] as unknown as QueueRow;

    if (action === 'approve') {
      const canonical = (final_canonical || item.proposed_canonical || '').trim();
      if (!canonical) return reply.code(400).send({ error: 'no canonical to approve' });
      await approveQueueItem(item, canonical);
    } else if (action === 'remove') {
      await sql`DELETE FROM verifikations_queue WHERE id = ${id}`;
    } else {
      await sql`UPDATE verifikations_queue SET status = 'rejected' WHERE id = ${id}`;
    }
    return { ok: true };
  });

  /** Bulk decide: approve / reject / remove many pending entries at once.
   *  Approve uses each entry's proposed_canonical (no per-item edit) and teaches
   *  an authoritative alias just like the single-item path. */
  app.post('/api/queue/decide-bulk', async (req, reply) => {
    const { ids, action } = (req.body ?? {}) as { ids?: number[]; action?: string };
    if (!Array.isArray(ids) || !ids.length || !action) return reply.code(400).send({ error: 'ids and action required' });
    if (!['approve', 'reject', 'remove'].includes(action)) return reply.code(400).send({ error: 'bad action' });

    if (action === 'remove') {
      await sql`DELETE FROM verifikations_queue WHERE id IN ${sql(ids)} AND status = 'pending'`;
      return { ok: true, count: ids.length };
    }
    if (action === 'reject') {
      const r = await sql`UPDATE verifikations_queue SET status = 'rejected' WHERE id IN ${sql(ids)} AND status = 'pending'`;
      return { ok: true, count: r.count };
    }

    // approve
    const rows = await sql`SELECT id, proposed_canonical, ai_examples, raw_patterns, artikel_id FROM verifikations_queue WHERE id IN ${sql(ids)} AND status = 'pending'`;
    let count = 0;
    for (const r of rows as unknown as QueueRow[]) {
      const canonical = (r.proposed_canonical ?? '').trim();
      if (!canonical) continue;
      await approveQueueItem(r, canonical);
      count++;
    }
    return { ok: true, count };
  });
}
