import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireOperator } from '../auth/plugin.js';

export function unitRoutes(app: FastifyInstance): void {
  /** The managed unit list — powers every unit dropdown in the app. */
  app.get('/api/units', async () => {
    return sql`SELECT name, dimension, to_base::float8 AS to_base, sort_order, builtin
               FROM unit ORDER BY sort_order, name`;
  });

  /** Add a custom unit (operator). dimension defaults to 'count' (to_base 1).
   *  requireOperator, not requireAdmin: `unit` (migrations/032_units.sql) never got a household_id
   *  column, so it is NOT RLS-scoped — it is a platform-global catalogue. On the demo requireAdmin
   *  is satisfied by every visitor, so one INSERT landed in EVERY household's unit dropdown and in
   *  loadUnits(), which feeds the comparisonGroups()/estimateVorrat() price-per-unit maths for all
   *  of them — a cross-tenant write through a household-level guard, uncapped and unvalidated
   *  beyond a trim. Off-demo requireOperator IS is_admin, so self-hosters are unchanged.
   *  The durable fix is a household_id + tenant_isolation policy on `unit` like the other
   *  catalogue tables; this guard stops the cross-tenant write today. */
  app.post('/api/units', { preHandler: requireOperator }, async (req, reply) => {
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
