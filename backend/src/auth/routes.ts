import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import sql from '../db.js';
import { signToken } from './plugin.js';

export function authRoutes(app: FastifyInstance): void {
  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: 'missing credentials' });

    const rows = await sql`
      SELECT id, username, password_hash, is_admin, prefers_dark, preferred_lang
      FROM users WHERE LOWER(username) = LOWER(${username})
    `;
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    const u = rows[0];
    return {
      token: signToken(u.id),
      user: {
        id: u.id,
        username: u.username,
        is_admin: u.is_admin,
        prefers_dark: u.prefers_dark,
        preferred_lang: u.preferred_lang,
      },
    };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));
}
