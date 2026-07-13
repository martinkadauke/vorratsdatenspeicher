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
    // public, token-protected email link (model-review approve/reject from the mail)
    if (req.method === 'GET' && /^\/api\/model-review\/\d+\/decide$/.test(url)) return;

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
        SELECT u.id, u.username, u.email, u.is_admin, u.sees_all_konten, u.can_write, u.prefers_dark, u.preferred_lang, u.has_seen_tour, u.pinned_chains, u.emoji,
               (SELECT emoji FROM family_member WHERE user_id = u.id AND emoji IS NOT NULL ORDER BY sort_order LIMIT 1) AS member_emoji
        FROM users u WHERE u.id = ${payload.sub}
      `;
      if (!rows.length) return reply.code(401).send({ error: 'unauthorized' });
      const row = rows[0];
      const user = rows[0] as unknown as User;
      user.emoji = resolvedEmoji(row.emoji as string | null, row.member_emoji as string | null, user.is_admin);

      // Read-only accounts (can_write = false, non-admin) may not mutate data.
      // Self-service prefs/own-password (PATCH /api/me) stay allowed.
      if (!user.is_admin && user.can_write === false
          && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
          && url !== '/api/me'
          && !url.startsWith('/api/analytics/')   // analytics endpoints are reads (POST carries the query body)
          && !url.startsWith('/api/spending/ask')) {   // NL assistant is a read (POST carries the question)
        return reply.code(403).send({ error: 'read_only', message: 'Nur-Lese-Zugang – Änderungen sind für dieses Konto deaktiviert.' });
      }
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

/** Avatar emoji shown in the header: own emoji → linked family member's → 🤖 for admins. */
export function resolvedEmoji(userEmoji: string | null, memberEmoji: string | null, isAdmin: boolean): string | null {
  return userEmoji ?? memberEmoji ?? (isAdmin ? '🤖' : null);
}
