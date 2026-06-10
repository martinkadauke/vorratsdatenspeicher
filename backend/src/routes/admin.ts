import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { getAllConfig, setConfig, getConfig } from '../config.js';
import { rescheduleChurner } from '../churner/scheduler.js';
import { listOllamaModels, ollamaHealth } from '../llm/ollama.js';
import { searxngHealth } from '../llm/searxng.js';
import { sendMail } from '../mailer.js';
import { createAuthToken } from '../auth/routes.js';

export function adminRoutes(app: FastifyInstance): void {
  // ── app config ──────────────────────────────────────────────────────────
  app.get('/api/config', { preHandler: requireAdmin }, async () => getAllConfig());

  app.put('/api/config/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const { value } = (req.body ?? {}) as { value?: unknown };
    if (value === undefined) return reply.code(400).send({ error: 'value required' });
    await setConfig(key, value, req.user!.id);
    if (key.startsWith('churner.')) await rescheduleChurner();
    return { ok: true };
  });

  // ── users (invite-only) ─────────────────────────────────────────────────
  app.get('/api/users', { preHandler: requireAdmin }, async () => {
    return sql`SELECT id, username, email, is_admin, prefers_dark, preferred_lang, created_at FROM users ORDER BY id`;
  });

  /** Invite a new user by email. Creates the account with a random password
   *  and sends an invite link; if SMTP is unavailable the link is returned
   *  so the admin can share it manually. */
  app.post('/api/users/invite', { preHandler: requireAdmin }, async (req, reply) => {
    const { email, username, is_admin } = (req.body ?? {}) as {
      email?: string; username?: string; is_admin?: boolean;
    };
    if (!email || !username) return reply.code(400).send({ error: 'email and username required' });

    const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    let userId: number;
    try {
      const [row] = await sql`
        INSERT INTO users (username, email, password_hash, is_admin)
        VALUES (${username}, ${email}, ${randomHash}, ${is_admin ?? false})
        RETURNING id
      `;
      userId = row.id;
    } catch {
      return reply.code(409).send({ error: 'username or email already exists' });
    }

    const token = await createAuthToken(userId, 'invite', 7 * 24);
    const base = await getConfig('app.base_url');
    const link = `${base}/reset?token=${token}`;

    let emailed = false;
    try {
      await sendMail(
        email,
        'Einladung zu Vorratsdatenspeicher',
        `Hallo ${username},\n\n` +
        `du wurdest zu Vorratsdatenspeicher eingeladen. ` +
        `Setze über diesen Link dein Passwort (7 Tage gültig):\n\n${link}\n`,
      );
      emailed = true;
    } catch (e) {
      req.log.warn(`invite mail failed: ${(e as Error).message}`);
    }

    return { ok: true, id: userId, emailed, invite_link: link };
  });

  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { is_admin, password, email } = (req.body ?? {}) as {
      is_admin?: boolean; password?: string; email?: string;
    };

    if (is_admin === false && id === req.user!.id) {
      return reply.code(400).send({ error: 'cannot demote yourself' });
    }
    const updates: Record<string, unknown> = {};
    if (is_admin !== undefined) updates.is_admin = is_admin;
    if (password) updates.password_hash = await bcrypt.hash(password, 12);
    if (email !== undefined) updates.email = email || null;
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    await sql`UPDATE users SET ${sql(updates)} WHERE id = ${id}`;
    return { ok: true };
  });

  /** Send a fresh reset link to an existing user (admin action). */
  app.post('/api/users/:id/send-reset', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const rows = await sql`SELECT username, email FROM users WHERE id = ${id}`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    const token = await createAuthToken(id, 'reset', 24);
    const base = await getConfig('app.base_url');
    const link = `${base}/reset?token=${token}`;
    let emailed = false;
    if (rows[0].email) {
      try {
        await sendMail(
          rows[0].email,
          'Vorratsdatenspeicher – Passwort zurücksetzen',
          `Hallo ${rows[0].username},\n\nneues Passwort setzen (24h gültig):\n\n${link}\n`,
        );
        emailed = true;
      } catch (e) {
        req.log.warn(`reset mail failed: ${(e as Error).message}`);
      }
    }
    return { ok: true, emailed, reset_link: link };
  });

  // ── smtp test ───────────────────────────────────────────────────────────
  app.post('/api/smtp/test', { preHandler: requireAdmin }, async (req, reply) => {
    const { to } = (req.body ?? {}) as { to?: string };
    if (!to) return reply.code(400).send({ error: 'to required' });
    try {
      await sendMail(to, 'Vorratsdatenspeicher – SMTP Test', 'SMTP funktioniert! 🎉');
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (id === req.user!.id) return reply.code(400).send({ error: 'cannot delete yourself' });
    await sql`DELETE FROM users WHERE id = ${id}`;
    return { ok: true };
  });

  // ── ollama / searxng helpers ────────────────────────────────────────────
  app.get('/api/ollama/models', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      return { models: await listOllamaModels() };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/ollama/health', { preHandler: requireAdmin }, async () => ollamaHealth());
  app.get('/api/searxng/health', { preHandler: requireAdmin }, async () => searxngHealth());
}
