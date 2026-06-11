import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import sql from '../db.js';

export function meRoutes(app: FastifyInstance): void {
  app.patch('/api/me', async (req, reply) => {
    const userId = req.user!.id;
    const { prefers_dark, preferred_lang, password, old_password, has_seen_tour } = (req.body ?? {}) as {
      prefers_dark?: boolean; preferred_lang?: string; password?: string; old_password?: string; has_seen_tour?: boolean;
    };

    const updates: Record<string, unknown> = {};
    if (prefers_dark !== undefined) updates.prefers_dark = prefers_dark;
    if (has_seen_tour !== undefined) updates.has_seen_tour = has_seen_tour;
    if (preferred_lang !== undefined) {
      if (!['de', 'en'].includes(preferred_lang)) return reply.code(400).send({ error: 'lang must be de or en' });
      updates.preferred_lang = preferred_lang;
    }
    if (password) {
      const rows = await sql`SELECT password_hash FROM users WHERE id = ${userId}`;
      if (!old_password || !(await bcrypt.compare(old_password, rows[0].password_hash))) {
        return reply.code(403).send({ error: 'old password incorrect' });
      }
      updates.password_hash = await bcrypt.hash(password, 12);
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });

    await sql`UPDATE users SET ${sql(updates)} WHERE id = ${userId}`;
    return { ok: true };
  });
}
