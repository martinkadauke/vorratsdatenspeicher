import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';

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
          ${kontoScope(req.user, sql`e2.konto_id`)}
        ORDER BY e2.datum DESC, a2.id DESC
        LIMIT 1
      ) fb ON TRUE
      WHERE q.status = 'pending' ${searchCond}
        ${kontoScope(req.user, sql`e.konto_id`)}
      ${order}
      LIMIT 200
    `;
    const [{ total }] = await sql`
      SELECT COUNT(*)::int AS total
      FROM verifikations_queue q
      LEFT JOIN artikel a ON a.id = q.artikel_id
      LEFT JOIN einkauf e ON e.id = a.einkauf_id
      WHERE q.status = 'pending'
        ${kontoScope(req.user, sql`e.konto_id`)}
    `;
    return { items, total };
  });

  app.post('/api/queue/decide', async (req, reply) => {
    const { id, action, final_canonical } = (req.body ?? {}) as {
      id?: number; action?: string; final_canonical?: string;
    };
    if (!id || !action) return reply.code(400).send({ error: 'id and action required' });

    const items = await sql`SELECT id, proposed_canonical, ai_examples FROM verifikations_queue WHERE id = ${id}`;
    if (!items.length) return reply.code(404).send({ error: 'not found' });
    const item = items[0];

    if (action === 'approve') {
      const canonical = final_canonical || (item.proposed_canonical as string);
      await sql.begin(async tx => {
        await tx`
          UPDATE artikel SET canonical_name = ${canonical}
          WHERE canonical_name IS NULL
            AND COALESCE(NULLIF(ai_guess, ''), name) = ${item.ai_examples}
        `;
        await tx`UPDATE verifikations_queue SET status = 'approved' WHERE id = ${id}`;
      });
    } else if (action === 'remove') {
      await sql`DELETE FROM verifikations_queue WHERE id = ${id}`;
    } else {
      await sql`UPDATE verifikations_queue SET status = 'rejected' WHERE id = ${id}`;
    }
    return { ok: true };
  });

  /** Bulk decide: approve / reject / remove many pending entries at once.
   *  Approve uses each entry's proposed_canonical (no per-item edit). */
  app.post('/api/queue/decide-bulk', async (req, reply) => {
    const { ids, action } = (req.body ?? {}) as { ids?: number[]; action?: string };
    if (!Array.isArray(ids) || !ids.length || !action) return reply.code(400).send({ error: 'ids and action required' });
    if (!['approve', 'reject', 'remove'].includes(action)) return reply.code(400).send({ error: 'bad action' });
    const rows = await sql`SELECT id, proposed_canonical, ai_examples FROM verifikations_queue WHERE id IN ${sql(ids)} AND status = 'pending'`;
    await sql.begin(async tx => {
      for (const item of rows) {
        if (action === 'approve') {
          const canonical = item.proposed_canonical as string | null;
          if (!canonical) continue;
          await tx`
            UPDATE artikel SET canonical_name = ${canonical}
            WHERE canonical_name IS NULL AND COALESCE(NULLIF(ai_guess, ''), name) = ${item.ai_examples}
          `;
          await tx`UPDATE verifikations_queue SET status = 'approved' WHERE id = ${item.id}`;
        } else if (action === 'remove') {
          await tx`DELETE FROM verifikations_queue WHERE id = ${item.id}`;
        } else {
          await tx`UPDATE verifikations_queue SET status = 'rejected' WHERE id = ${item.id}`;
        }
      }
    });
    return { ok: true, count: rows.length };
  });
}
