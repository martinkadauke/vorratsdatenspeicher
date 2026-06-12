import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { kontoScope } from '../auth/konto.js';

export function kontoRoutes(app: FastifyInstance): void {
  /** Accounts the current user may see (for selectors / move-to-list).
   *  Includes the user-visible receipt count so the overview can hide
   *  empty accounts from its filter chips. */
  app.get('/api/konten', async (req) => {
    const idFilter = req.user?.sees_all_konten ? sql`` : (() => {
      const ids = req.user?.konto_ids ?? [];
      return ids.length ? sql`WHERE k.id IN ${sql(ids)}` : sql`WHERE FALSE`;
    })();
    return sql`
      SELECT k.id, k.name, k.is_shared, k.user_id, u.username AS owner,
             (SELECT COUNT(*)::int FROM einkauf e
              WHERE e.konto_id = k.id ${kontoScope(req.user, sql`e.konto_id`)}) AS receipts
      FROM konto k LEFT JOIN users u ON u.id = k.user_id
      ${idFilter}
      ORDER BY k.is_shared DESC, k.sort_order, k.name
    `;
  });

  /** Full account list (admin) with receipt counts. */
  app.get('/api/admin/konten', { preHandler: requireAdmin }, async () => {
    return sql`
      SELECT k.id, k.name, k.is_shared, k.user_id, u.username AS owner, k.sort_order,
             (SELECT COUNT(*)::int FROM einkauf e WHERE e.konto_id = k.id) AS receipts
      FROM konto k LEFT JOIN users u ON u.id = k.user_id
      ORDER BY k.is_shared DESC, k.sort_order, k.name
    `;
  });

  app.post('/api/admin/konten', { preHandler: requireAdmin }, async (req, reply) => {
    const { name, is_shared, user_id } = (req.body ?? {}) as { name?: string; is_shared?: boolean; user_id?: number | null };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    const [row] = await sql`
      INSERT INTO konto (name, is_shared, user_id)
      VALUES (${name.trim()}, ${is_shared ?? false}, ${user_id ?? null})
      RETURNING id
    `;
    return { ok: true, id: row.id };
  });

  app.patch('/api/admin/konten/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const body = (req.body ?? {}) as { name?: string; is_shared?: boolean; user_id?: number | null; sort_order?: number };
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.is_shared !== undefined) updates.is_shared = body.is_shared;
    if ('user_id' in body) updates.user_id = body.user_id ?? null;
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    const rows = await sql`UPDATE konto SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/admin/konten/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const [used] = await sql`SELECT COUNT(*)::int AS n FROM einkauf WHERE konto_id = ${id}`;
    if (used.n > 0) return reply.code(409).send({ error: `account has ${used.n} receipts — move them first` });
    const [shared] = await sql`SELECT is_shared FROM konto WHERE id = ${id}`;
    if (shared?.is_shared) return reply.code(409).send({ error: 'cannot delete the shared account' });
    await sql`DELETE FROM konto WHERE id = ${id}`;
    return { ok: true };
  });
}
