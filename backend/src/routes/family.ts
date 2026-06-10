import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';

export function familyRoutes(app: FastifyInstance): void {
  app.get('/api/family', async () => {
    return sql`SELECT id, name, color, emoji, user_id, sort_order FROM family_member ORDER BY sort_order, id`;
  });

  app.post('/api/family', { preHandler: requireAdmin }, async (req, reply) => {
    const { name, color, emoji, user_id, sort_order } = (req.body ?? {}) as {
      name?: string; color?: string; emoji?: string; user_id?: number; sort_order?: number;
    };
    if (!name) return reply.code(400).send({ error: 'name required' });
    const [row] = await sql`
      INSERT INTO family_member (name, color, emoji, user_id, sort_order)
      VALUES (${name}, ${color ?? null}, ${emoji ?? null}, ${user_id ?? null}, ${sort_order ?? 99})
      RETURNING id
    `;
    return { ok: true, id: row.id };
  });

  app.patch('/api/family/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    for (const key of ['name', 'color', 'emoji', 'user_id', 'sort_order']) {
      if (key in body) updates[key] = body[key];
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    const rows = await sql`UPDATE family_member SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/family/:id', { preHandler: requireAdmin }, async (req) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    await sql`DELETE FROM family_member WHERE id = ${id}`;
    return { ok: true };
  });
}
