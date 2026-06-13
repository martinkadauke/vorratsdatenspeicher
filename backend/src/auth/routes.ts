import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import sql from '../db.js';
import { signToken } from './plugin.js';
import { sendMail } from '../mailer.js';
import { resetEmail } from '../email/templates.js';
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

    const rows = await sql`
      SELECT id, username, password_hash, is_admin, sees_all_konten, can_write, prefers_dark, preferred_lang, email, has_seen_tour, pinned_chains
      FROM users
      WHERE LOWER(username) = LOWER(${username}) OR LOWER(email) = LOWER(${username})
    `;
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
        pinned_chains: u.pinned_chains,
      },
    };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));

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

  /** Set a new password via invite/reset token. */
  app.post('/api/auth/reset', async (req, reply) => {
    const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
    if (!token || !password) return reply.code(400).send({ error: 'token and password required' });
    if (password.length < 8) return reply.code(400).send({ error: 'password too short (min 8)' });

    const rows = await sql`
      SELECT id, user_id FROM auth_token
      WHERE token = ${token} AND used_at IS NULL AND expires_at > NOW()
    `;
    if (!rows.length) return reply.code(400).send({ error: 'invalid or expired token' });

    const hash = await bcrypt.hash(password, 12);
    await sql.begin(async tx => {
      await tx`UPDATE users SET password_hash = ${hash} WHERE id = ${rows[0].user_id}`;
      await tx`UPDATE auth_token SET used_at = NOW() WHERE id = ${rows[0].id}`;
    });
    return { ok: true };
  });
}
