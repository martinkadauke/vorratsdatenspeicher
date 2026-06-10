import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

export function queueRoutes(app: FastifyInstance): void {
  app.get('/api/queue', async () => {
    return sql`
      SELECT id, proposed_canonical, raw_patterns, ai_examples, confidence, status, created_at
      FROM verifikations_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 50
    `;
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
}
