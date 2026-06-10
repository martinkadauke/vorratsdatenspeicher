import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';

export function categoryRoutes(app: FastifyInstance): void {
  app.get('/api/categories', async (req) => {
    const lang = (req.query as { lang?: string }).lang ?? req.user?.preferred_lang ?? 'de';
    const rows = await sql`
      SELECT id, path, parent_path, display, display_en, level, sort_order, emoji, is_meta
      FROM category ORDER BY sort_order, path
    `;
    return rows.map(r => ({
      ...r,
      label: lang === 'en' && r.display_en ? r.display_en : r.display,
    }));
  });

  app.post('/api/categories', { preHandler: requireAdmin }, async (req, reply) => {
    const { path, display, display_en, emoji, sort_order } = (req.body ?? {}) as {
      path?: string; display?: string; display_en?: string; emoji?: string; sort_order?: number;
    };
    if (!path || !display) return reply.code(400).send({ error: 'path and display required' });
    const parts = path.split('/');
    const level = parts.length;
    if (level > 3) return reply.code(400).send({ error: 'max 3 levels' });
    const parent = level > 1 ? parts.slice(0, -1).join('/') : null;
    if (parent) {
      const exists = await sql`SELECT 1 FROM category WHERE path = ${parent}`;
      if (!exists.length) return reply.code(400).send({ error: `parent ${parent} does not exist` });
    }
    await sql`
      INSERT INTO category (path, parent_path, display, display_en, level, sort_order, emoji)
      VALUES (${path}, ${parent}, ${display}, ${display_en ?? null}, ${level}, ${sort_order ?? 0}, ${emoji ?? null})
    `;
    return { ok: true };
  });

  app.patch('/api/categories/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    for (const key of ['display', 'display_en', 'emoji', 'sort_order']) {
      if (key in body) updates[key] = body[key];
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    const rows = await sql`UPDATE category SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/categories/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const rows = await sql`SELECT path FROM category WHERE id = ${id}`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    const path = rows[0].path as string;

    const [children] = await sql`SELECT COUNT(*)::int AS n FROM category WHERE parent_path = ${path}`;
    if (children.n > 0) return reply.code(409).send({ error: 'category has children' });
    const [used] = await sql`SELECT COUNT(*)::int AS n FROM artikel WHERE category_path = ${path}`;
    if (used.n > 0) return reply.code(409).send({ error: `category used by ${used.n} artikel` });

    await sql`DELETE FROM category WHERE id = ${id}`;
    return { ok: true };
  });
}
