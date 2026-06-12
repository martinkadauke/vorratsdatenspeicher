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
    if (['/api/health', '/api/ready', '/api/version', '/api/auth/login', '/api/auth/forgot', '/api/auth/reset', '/api/auth/token-info'].includes(url)) return;

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
        SELECT id, username, email, is_admin, sees_all_konten, prefers_dark, preferred_lang, has_seen_tour
        FROM users WHERE id = ${payload.sub}
      `;
      if (!rows.length) return reply.code(401).send({ error: 'unauthorized' });
      const user = rows[0] as unknown as User;
      // Accounts this user may see: shared (GKK) + their own personal accounts.
      // Super-admins (sees_all_konten) skip filtering entirely.
      if (!user.sees_all_konten) {
        const ks = await sql`SELECT id FROM konto WHERE is_shared = TRUE OR user_id = ${user.id}`;
        user.konto_ids = ks.map(r => r.id as number);
      }
      req.user = user;
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

/** Super-admin = sees every account. Gates the data-management area. */
export async function requireSuperAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user?.sees_all_konten) {
    return reply.code(403).send({ error: 'forbidden' });
  }
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}
