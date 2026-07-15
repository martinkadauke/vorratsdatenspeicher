import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import sql, { adminSql, DEMO_MODE } from '../db.js';
import { signToken, resolvedEmoji } from './plugin.js';
import { sendMail } from '../mailer.js';
import { resetEmail, newHouseholdEmail } from '../email/templates.js';
import { getConfig } from '../config.js';

export async function createAuthToken(userId: number, kind: 'invite' | 'reset', hours: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await sql`
    INSERT INTO auth_token (user_id, kind, token, expires_at)
    VALUES (${userId}, ${kind}, ${token}, NOW() + ${hours} * INTERVAL '1 hour')
  `;
  return token;
}

// Simple in-memory login throttle to slow down brute-force attempts.
// Per-IP: 8 failed attempts in 10 minutes → 401 with "too many attempts" until window resets.
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60_000;

function trackFailure(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

function clearFailures(ip: string): void {
  loginAttempts.delete(ip);
}

export function authRoutes(app: FastifyInstance): void {
  app.post('/api/auth/login', async (req, reply) => {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const existing = loginAttempts.get(ip);
    if (existing && existing.count > MAX_ATTEMPTS && existing.resetAt > Date.now()) {
      return reply.code(429).send({ error: 'too many attempts — please wait a few minutes' });
    }

    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ error: 'missing credentials' });

    // Demo: email is the global login identity + carries household/super-admin fields (uses the
    // owner connection to bootstrap before a tenant context exists). Non-demo: original lookup.
    const rows = DEMO_MODE
      ? await adminSql`
          SELECT u.id, u.username, u.password_hash, u.is_admin, u.sees_all_konten, u.is_super_admin, u.household_id, u.can_write, u.prefers_dark, u.preferred_lang, u.email, u.has_seen_tour, u.pinned_chains, u.emoji,
                 h.onboarding_done,
                 (SELECT emoji FROM family_member WHERE user_id = u.id AND emoji IS NOT NULL ORDER BY sort_order LIMIT 1) AS member_emoji
          FROM users u LEFT JOIN household h ON h.id = u.household_id
          WHERE LOWER(u.email) = LOWER(${username})`
      : await sql`
          SELECT u.id, u.username, u.password_hash, u.is_admin, u.sees_all_konten, u.can_write, u.prefers_dark, u.preferred_lang, u.email, u.has_seen_tour, u.pinned_chains, u.emoji,
                 (SELECT emoji FROM family_member WHERE user_id = u.id AND emoji IS NOT NULL ORDER BY sort_order LIMIT 1) AS member_emoji
          FROM users u
          WHERE LOWER(u.username) = LOWER(${username}) OR LOWER(u.email) = LOWER(${username})`;
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      const blocked = trackFailure(ip);
      if (blocked) return reply.code(429).send({ error: 'too many attempts — please wait a few minutes' });
      return reply.code(401).send({ error: 'invalid credentials' });
    }
    clearFailures(ip);
    const u = rows[0];
    return {
      token: signToken(u.id),
      user: {
        id: u.id,
        username: u.username,
        is_admin: u.is_admin,
        sees_all_konten: u.sees_all_konten,
        can_write: u.can_write,
        prefers_dark: u.prefers_dark,
        preferred_lang: u.preferred_lang,
        email: u.email,
        has_seen_tour: u.has_seen_tour,
        emoji: resolvedEmoji(u.emoji, u.member_emoji),
        pinned_chains: u.pinned_chains,
        ...(DEMO_MODE
          ? { is_super_admin: u.is_super_admin, household_id: u.household_id, onboarding_done: u.onboarding_done ?? false }
          : { onboarding_done: await getConfig('onboarding.done') }),
      },
    };
  });

  // Merge the onboarding flag onto the current-user payload so the first-run wizard runs
  // without a config GET. Demo: per-household (household.onboarding_done). Non-demo: global config.
  app.get('/api/auth/me', async (req) => {
    if (DEMO_MODE) {
      const [hh] = await adminSql`SELECT onboarding_done FROM household WHERE id = ${req.user!.household_id ?? 1}`;
      return { user: { ...req.user, onboarding_done: hh?.onboarding_done ?? false } };
    }
    return { user: { ...req.user, onboarding_done: await getConfig('onboarding.done') } };
  });

  // ── Demo: open signup — a brand-new household + its admin ─────────────────
  if (DEMO_MODE) {
    app.post('/api/auth/signup', async (req, reply) => {
      const { email, password, household } = (req.body ?? {}) as { email?: string; password?: string; household?: string };
      const cleanEmail = (email ?? '').trim().toLowerCase();
      if (!cleanEmail || !password) return reply.code(400).send({ error: 'email and password required' });
      if (password.length < 8) return reply.code(400).send({ error: 'password too short (min 8)' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return reply.code(400).send({ error: 'invalid email' });

      const dup = await adminSql`SELECT 1 FROM users WHERE LOWER(email) = ${cleanEmail} LIMIT 1`;
      if (dup.length) return reply.code(409).send({ error: 'email already registered' });

      const hhName = (household?.trim() || 'Mein Haushalt').slice(0, 60);
      const username = (cleanEmail.split('@')[0] || 'admin').slice(0, 40);
      const hash = await bcrypt.hash(password, 12);

      const userId = await adminSql.begin(async tx => {
        const [{ id: hid }] = await tx`INSERT INTO household (name, is_demo) VALUES (${hhName}, TRUE) RETURNING id`;
        const [{ id: uid }] = await tx`
          INSERT INTO users (username, email, password_hash, is_admin, sees_all_konten, is_super_admin, household_id)
          VALUES (${username}, ${cleanEmail}, ${hash}, TRUE, TRUE, FALSE, ${hid}) RETURNING id`;
        await tx`INSERT INTO konto (name, is_shared, sort_order, is_cash, account_type, household_id)
                 VALUES ('Haushaltskonto', TRUE, 0, FALSE, 'giro', ${hid})`;
        await tx`INSERT INTO category (path, parent_path, display, display_en, level, sort_order, emoji, is_meta, household_id)
                 SELECT path, parent_path, display, display_en, level, sort_order, emoji, is_meta, ${hid}
                 FROM category WHERE household_id = 1`;
        return uid as number;
      });
      void (async () => {
        try {
          const [{ n }] = await adminSql`SELECT count(*)::int AS n FROM household`;
          const mail = newHouseholdEmail({ householdName: hhName, adminEmail: cleanEmail, total: n as number });
          await sendMail('webmaster@vorratsdatenspeicher.com', mail.subject, mail.text, mail.html, cleanEmail);
        } catch (err) { req.log.error(`new-household mail failed: ${(err as Error).message}`); }
      })();
      return { token: signToken(userId as number) };
    });
  }

  /** Request a password reset. Always answers ok — no user enumeration. */
  app.post('/api/auth/forgot', async (req) => {
    const { email } = (req.body ?? {}) as { email?: string };
    if (email) {
      const rows = await sql`SELECT id, username FROM users WHERE LOWER(email) = LOWER(${email})`;
      if (rows.length) {
        try {
          const token = await createAuthToken(rows[0].id, 'reset', 2);
          const base = await getConfig('app.base_url');
          const mail = resetEmail({ username: rows[0].username, link: `${base}/reset?token=${token}`, validity: '2 Stunden' });
          await sendMail(email, mail.subject, mail.text, mail.html);
        } catch (e) {
          req.log.error(`forgot-password mail failed: ${(e as Error).message}`);
        }
      }
    }
    return { ok: true };
  });

  /** Info about an invite/reset token (for rendering the reset page). */
  app.get('/api/auth/token-info', async (req) => {
    const token = (req.query as { token?: string }).token ?? '';
    const rows = await sql`
      SELECT t.kind, u.username
      FROM auth_token t JOIN users u ON u.id = t.user_id
      WHERE t.token = ${token} AND t.used_at IS NULL AND t.expires_at > NOW()
    `;
    if (!rows.length) return { valid: false };
    return { valid: true, kind: rows[0].kind, username: rows[0].username };
  });

  /** Set a new password via invite/reset token (and, on invite, the chosen emoji). */
  app.post('/api/auth/reset', async (req, reply) => {
    const { token, password, emoji } = (req.body ?? {}) as { token?: string; password?: string; emoji?: string };
    if (!token || !password) return reply.code(400).send({ error: 'token and password required' });
    if (password.length < 8) return reply.code(400).send({ error: 'password too short (min 8)' });
    const cleanEmoji = typeof emoji === 'string' && emoji.trim() ? emoji.trim().slice(0, 16) : null;

    const rows = await sql`
      SELECT id, user_id FROM auth_token
      WHERE token = ${token} AND used_at IS NULL AND expires_at > NOW()
    `;
    if (!rows.length) return reply.code(400).send({ error: 'invalid or expired token' });

    const hash = await bcrypt.hash(password, 12);
    await sql.begin(async tx => {
      await tx`UPDATE users SET password_hash = ${hash} WHERE id = ${rows[0].user_id}`;
      if (cleanEmoji) await tx`UPDATE users SET emoji = ${cleanEmoji} WHERE id = ${rows[0].user_id}`;
      await tx`UPDATE auth_token SET used_at = NOW() WHERE id = ${rows[0].id}`;
    });
    return { ok: true };
  });
}
