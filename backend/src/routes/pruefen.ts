import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { applyCanonicalToArticles } from '../lib/applyCanonical.js';

/**
 * Article-driven Prüfen (review) list.
 *
 * Unlike the legacy queue dump, this is sourced from `artikel` — every article
 * that still needs a human decision (no canonical name yet, and not already
 * human-corrected), grouped by its stored `ocr_key` so 200 receipts of the same
 * line collapse to ONE review row. The churner's pending proposal is LATERAL-joined
 * as a pre-fill suggestion; if none exists the row still appears (ai_guess pre-fill),
 * so nothing falls through. A named/human article drops out automatically — the
 * page self-heals.
 *
 * Honors the "don't touch the clean base" constraint: only `canonical_name IS NULL`
 * articles surface, so the existing named catalog is never re-opened.
 */
export function pruefenRoutes(app: FastifyInstance): void {
  const needsCount = (req: { user?: Parameters<typeof kontoScope>[0] }) => sql`
    SELECT COUNT(DISTINCT COALESCE(NULLIF(a.ocr_key, ''), 'id:' || a.id))::int AS count
    FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
    WHERE a.canonical_name IS NULL AND a.user_corrected = FALSE
      ${kontoScope(req.user, sql`e`)}
  `;

  app.get('/api/pruefen', async (req) => {
    const items = await sql`
      WITH needs AS (
        SELECT a.id, a.original_text, a.name, a.ai_guess, a.ocr_key, a.einkauf_id, e.datum,
               COALESCE(NULLIF(a.ocr_key, ''), 'id:' || a.id) AS grp
        FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
        WHERE a.canonical_name IS NULL AND a.user_corrected = FALSE
          ${kontoScope(req.user, sql`e`)}
      ),
      withprop AS (
        SELECT n.*, q.proposed_canonical, q.confidence, q.created_at AS prop_at
        FROM needs n
        LEFT JOIN LATERAL (
          SELECT vq.proposed_canonical, vq.confidence, vq.created_at
          FROM verifikations_queue vq
          WHERE vq.status = 'pending' AND vq.artikel_id = n.id
          ORDER BY vq.created_at DESC
          LIMIT 1
        ) q ON TRUE
      )
      SELECT * FROM (
        SELECT grp,
               array_agg(id ORDER BY id) AS artikel_ids,
               MIN(ocr_key) AS ocr_key,
               COUNT(*)::int AS occurrences,
               (array_agg(original_text ORDER BY id))[1] AS original_text,
               (array_agg(name ORDER BY id))[1] AS name,
               (array_agg(COALESCE(NULLIF(ai_guess, ''), name) ORDER BY id))[1] AS ai_guess,
               (array_agg(einkauf_id ORDER BY datum DESC NULLS LAST, id DESC))[1] AS einkauf_id,
               (array_agg(id ORDER BY datum DESC NULLS LAST, id DESC))[1] AS sample_artikel_id,
               (array_remove(array_agg(proposed_canonical ORDER BY prop_at DESC NULLS LAST), NULL))[1] AS suggestion,
               (array_remove(array_agg(confidence ORDER BY prop_at DESC NULLS LAST), NULL))[1] AS confidence
        FROM withprop
        GROUP BY grp
      ) g
      ORDER BY g.confidence::numeric ASC NULLS FIRST, g.occurrences DESC
      LIMIT 200
    `;
    const [{ count }] = await needsCount(req);
    return { items, total: count };
  });

  app.get('/api/pruefen/count', async (req) => {
    const [{ count }] = await needsCount(req);
    return { count };
  });

  app.post('/api/pruefen/decide', async (req, reply) => {
    const { artikel_ids, canonical, action } = (req.body ?? {}) as {
      artikel_ids?: number[]; canonical?: string; action?: string;
    };
    const ids = Array.isArray(artikel_ids) ? artikel_ids.filter(n => Number.isInteger(n)) : [];
    if (!ids.length || !action) return reply.code(400).send({ error: 'artikel_ids and action required' });

    if (action === 'approve') {
      const canon = (canonical ?? '').trim();
      if (!canon) return reply.code(400).send({ error: 'canonical required' });
      const updated = await applyCanonicalToArticles(ids, canon);
      return { ok: true, updated };
    }
    // reject: bury the proposals; the article stays unresolved and listed so the
    // human can rename it. Remember the rejection so the churner won't re-mint it.
    await sql`
      INSERT INTO rejected_proposal (ocr_key, proposed_canonical)
      SELECT a.ocr_key, vq.proposed_canonical
      FROM verifikations_queue vq JOIN artikel a ON a.id = vq.artikel_id
      WHERE vq.status = 'pending' AND vq.artikel_id IN ${sql(ids)}
        AND a.ocr_key IS NOT NULL AND a.ocr_key <> '' AND vq.proposed_canonical IS NOT NULL
      ON CONFLICT DO NOTHING
    `;
    await sql`
      UPDATE verifikations_queue SET status = 'rejected'
      WHERE status = 'pending' AND artikel_id IN ${sql(ids)}
    `;
    return { ok: true };
  });

  app.post('/api/pruefen/decide-bulk', async (req, reply) => {
    const { action, items } = (req.body ?? {}) as {
      action?: string; items?: { artikel_ids?: number[]; canonical?: string }[];
    };
    if (!action || !Array.isArray(items) || !items.length) return reply.code(400).send({ error: 'action and items required' });

    let count = 0;
    if (action === 'approve') {
      for (const it of items) {
        const ids = Array.isArray(it.artikel_ids) ? it.artikel_ids.filter(n => Number.isInteger(n)) : [];
        const canon = (it.canonical ?? '').trim();
        if (!ids.length || !canon) continue;
        await applyCanonicalToArticles(ids, canon);
        count++;
      }
    } else if (action === 'reject') {
      const allIds = items.flatMap(it => (Array.isArray(it.artikel_ids) ? it.artikel_ids : [])).filter(n => Number.isInteger(n));
      if (allIds.length) {
        await sql`
          INSERT INTO rejected_proposal (ocr_key, proposed_canonical)
          SELECT a.ocr_key, vq.proposed_canonical
          FROM verifikations_queue vq JOIN artikel a ON a.id = vq.artikel_id
          WHERE vq.status = 'pending' AND vq.artikel_id IN ${sql(allIds)}
            AND a.ocr_key IS NOT NULL AND a.ocr_key <> '' AND vq.proposed_canonical IS NOT NULL
          ON CONFLICT DO NOTHING
        `;
        await sql`UPDATE verifikations_queue SET status = 'rejected' WHERE status = 'pending' AND artikel_id IN ${sql(allIds)}`;
        count = items.length;
      }
    } else {
      return reply.code(400).send({ error: 'bad action' });
    }
    return { ok: true, count };
  });
}
