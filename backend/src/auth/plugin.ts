import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import sql, { adminSql, DEMO_MODE, openHousehold, closeHousehold, tenantContext, type TenantConn } from '../db.js';
import { JWT_SECRET, INTERNAL_SECRET } from '../config.js';
import type { User } from '../types.js';

declare module 'fastify' {
  interface FastifyRequest {
    reserved?: TenantConn; // demo: the household-scoped connection reserved for this request
  }
}

/** Global auth gate: every /api/* route except login and internal requires a valid JWT.
 *  In DEMO_MODE it also reserves a household-scoped connection per request (RLS). */
export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (['/api/health', '/api/ready', '/api/version', '/api/auth/login', '/api/auth/signup', '/api/auth/forgot', '/api/auth/reset', '/api/auth/token-info',
         '/api/auth/passkey/login/options', '/api/auth/passkey/login/verify',
         // First-run owner creation: no JWT can exist yet. Self-gated on "no user exists".
         '/api/auth/setup',
         // Desktop lock-out recovery: by definition nobody can present a token here. The factor is
         // physical — the shell shows a one-time code in an OS dialog no web page can read — and
         // every one of these is inert unless DESKTOP_DIR is set (i.e. never in Docker).
         '/api/desktop/recover', '/api/desktop/recover/confirm', '/api/desktop/admins'].includes(url)) return;
    // public, token-protected email link (model-review approve/reject from the mail)
    if (req.method === 'GET' && /^\/api\/model-review\/\d+\/decide$/.test(url)) return;
    // signed one-time backup download link (authorised by the ?s= HMAC, not a JWT)
    if (req.method === 'GET' && url === '/api/backup/download') return;

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
      // Demo: load the user on the OWNER connection (bypasses RLS to bootstrap the request)
      // and pull the household/super-admin fields. Non-demo: the original single-household load.
      // `demo_scanned` answers "has this household ever scanned a receipt of its own?" for the
      // first-run scanner preload: household.ocr_count is the exact signal, since it is bumped
      // whenever a vision-OCR run is claimed (demo/limits.ts). The column exists ONLY in the
      // demo schema (migrations/demo/098_demo_limits.sql), hence demo branch only. household
      // carries no RLS, so the join is safe on the owner connection (same as the login query).
      const rows = DEMO_MODE
        ? await adminSql`
            SELECT u.id, u.username, u.email, u.is_admin, u.sees_all_konten, u.is_super_admin, u.household_id, u.can_write, u.prefers_dark, u.preferred_lang, u.has_seen_tour, u.has_seen_email_tutorial, u.pinned_chains, u.emoji,
                   (COALESCE(h.ocr_count, 0) > 0) AS demo_scanned,
                   (SELECT emoji FROM family_member WHERE user_id = u.id AND emoji IS NOT NULL ORDER BY sort_order LIMIT 1) AS member_emoji
            FROM users u LEFT JOIN household h ON h.id = u.household_id
            WHERE u.id = ${payload.sub}`
        : await sql`
            SELECT u.id, u.username, u.email, u.is_admin, u.sees_all_konten, u.can_write, u.prefers_dark, u.preferred_lang, u.has_seen_tour, u.has_seen_email_tutorial, u.pinned_chains, u.emoji,
                   (SELECT emoji FROM family_member WHERE user_id = u.id AND emoji IS NOT NULL ORDER BY sort_order LIMIT 1) AS member_emoji
            FROM users u WHERE u.id = ${payload.sub}`;
      if (!rows.length) return reply.code(401).send({ error: 'unauthorized' });
      const row = rows[0];
      const user = rows[0] as unknown as User;
      user.emoji = resolvedEmoji(row.emoji as string | null, row.member_emoji as string | null);

      // Read-only accounts (can_write = false, non-admin) may not mutate data.
      if (!user.is_admin && user.can_write === false
          && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
          && url !== '/api/me'
          && !url.startsWith('/api/analytics/')
          && !url.startsWith('/api/spending/ask')) {
        return reply.code(403).send({ error: 'read_only', message: 'Nur-Lese-Zugang – Änderungen sind für dieses Konto deaktiviert.' });
      }

      // Demo: reserve this request's household-scoped connection (RLS); konto scoping happens
      // via RLS, so account filtering runs on that connection.
      const scoped: TenantConn = DEMO_MODE ? await openHousehold(user.household_id ?? 1) : sql;
      if (DEMO_MODE) req.reserved = scoped;

      // Accounts this user may see: shared (GKK) + their own personal accounts.
      if (!user.sees_all_konten) {
        const ks = await scoped`SELECT id FROM konto WHERE is_shared = TRUE OR user_id = ${user.id}`;
        user.konto_ids = ks.map(r => r.id as number);
      }
      req.user = user;
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // Demo: propagate the reserved household connection to handlers via AsyncLocalStorage. The
  // callback form is REQUIRED — an enterWith in the async hook above does NOT reach handlers.
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.reserved) tenantContext.run({ conn: req.reserved }, done);
    else done();
  });
  // Demo: release the reserved connection (resets the GUC).
  app.addHook('onResponse', async (req) => {
    if (req.reserved) { await closeHousehold(req.reserved); req.reserved = undefined; }
  });
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user?.is_admin) {
    return reply.code(403).send({ error: 'forbidden' });
  }
}

/** Super-admin = sees every account (gates data-management / backup). */
export async function requireSuperAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user?.sees_all_konten) {
    return reply.code(403).send({ error: 'forbidden' });
  }
}

/** Platform super-admin — gates data-management / backup / CSV export (originally
 *  requireSuperAdmin = sees_all_konten). Demo: the household-less operator (is_super_admin);
 *  non-demo: the single-household operator (sees_all_konten). Byte-for-byte off-demo. */
export async function requirePlatformAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ok = DEMO_MODE ? req.user?.is_super_admin : req.user?.sees_all_konten;
  if (!ok) return reply.code(403).send({ error: 'forbidden' });
}

/** Operator-only areas that ANY admin ran in the single-household app (originally
 *  requireAdmin = is_admin): AI providers/models/tasks, token usage, nightly maintenance,
 *  model review. On the demo these belong to the platform operator, NOT household admins,
 *  so they collapse to is_super_admin — but off-demo they stay is_admin (unchanged). This
 *  mirrors the frontend `operatorOnly = !demo || isSuper` section gating exactly. */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ok = DEMO_MODE ? req.user?.is_super_admin : req.user?.is_admin;
  if (!ok) return reply.code(403).send({ error: 'forbidden' });
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '7d' });
}

/** Avatar emoji shown in the header: the user's own chosen emoji, else a linked family
 *  member's, else none (the UI falls back to an icon/initial). Admins are NOT forced to a
 *  robot — they show whatever emoji they picked, like everyone else. */
export function resolvedEmoji(userEmoji: string | null, memberEmoji: string | null): string | null {
  return userEmoji ?? memberEmoji;
}
