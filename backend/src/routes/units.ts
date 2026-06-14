import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';

export function unitRoutes(app: FastifyInstance): void {
  /** The managed unit list — powers every unit dropdown in the app. */
  app.get('/api/units', async () => {
    return sql`SELECT name, dimension, to_base::float8 AS to_base, sort_order, builtin
               FROM unit ORDER BY sort_order, name`;
  });

  /** Add a custom unit (admin). dimension defaults to 'count' (to_base 1). */
  app.post('/api/units', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; dimension?: string; to_base?: number };
    const name = (b.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    const dimension = b.dimension === 'mass' || b.dimension === 'volume' ? b.dimension : 'count';
    const toBase = Number.isFinite(b.to_base) && (b.to_base as number) > 0 ? b.to_base : 1;
    const [{ next }] = await sql`SELECT COALESCE(MAX(sort_order), 0) + 10 AS next FROM unit`;
    await sql`
      INSERT INTO unit (name, dimension, to_base, sort_order, builtin)
      VALUES (${name}, ${dimension}, ${toBase as number}, ${next}, FALSE)
      ON CONFLICT (name) DO NOTHING`;
    return { ok: true };
  });
}
