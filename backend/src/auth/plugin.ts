import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import sql from '../db.js';
import { JWT_SECRET, INTERNAL_SECRET } from '../config.js';
import type { User } from '../types.js';

/** Global auth gate: every /api/* route except login and internal requires a valid JWT. */
export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (['/api/health', '/api/ready', '/api/auth/login', '/api/auth/forgot', '/api/auth/reset', '/api/auth/token-info'].includes(url)) return;

    if (url.startsWith('/api/internal/')) {
      if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      return;
    }

    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const payload = jwt.verify(token, JWT_SECRET) as unknown as { sub: number };
      const rows = await sql`
        SELECT id, username, is_admin, prefers_dark, preferred_lang
        FROM users WHERE id = ${payload.sub}
      `;
      if (!rows.length) return reply.code(401).send({ error: 'unauthorized' });
      req.user = rows[0] as unknown as User;
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user?.is_admin) {
    return reply.code(403).send({ error: 'forbidden' });
  }
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}
