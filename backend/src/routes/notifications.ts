import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

export function notificationRoutes(app: FastifyInstance): void {
  app.get('/api/notifications', async (req) => {
    const q = req.query as { unread?: string; limit?: string };
    const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 200);
    const onlyUnread = q.unread === 'true';
    const userId = req.user!.id;
    // Broadcast rows (user_id NULL) are shown to admins; personal rows to their owner.
    return sql`
      SELECT id, type, payload, user_id, created_at, read_at, acted_at
      FROM notification
      WHERE (user_id = ${userId} ${req.user!.is_admin ? sql`OR user_id IS NULL` : sql``})
        ${onlyUnread ? sql`AND read_at IS NULL` : sql``}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  });

  app.get('/api/notifications/unread-count', async (req) => {
    const userId = req.user!.id;
    const [row] = await sql`
      SELECT COUNT(*)::int AS n FROM notification
      WHERE read_at IS NULL
        AND (user_id = ${userId} ${req.user!.is_admin ? sql`OR user_id IS NULL` : sql``})
    `;
    return { count: row.n };
  });

  app.patch('/api/notifications/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { read, acted } = (req.body ?? {}) as { read?: boolean; acted?: boolean };
    const updates: Record<string, unknown> = {};
    if (read) updates.read_at = new Date();
    if (acted) updates.acted_at = new Date();
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    await sql`UPDATE notification SET ${sql(updates)} WHERE id = ${id}`;
    return { ok: true };
  });

  app.post('/api/notifications/read-all', async (req) => {
    const userId = req.user!.id;
    await sql`
      UPDATE notification SET read_at = NOW()
      WHERE read_at IS NULL
        AND (user_id = ${userId} ${req.user!.is_admin ? sql`OR user_id IS NULL` : sql``})
    `;
    return { ok: true };
  });
}
