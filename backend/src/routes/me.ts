import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import sql from '../db.js';

export function meRoutes(app: FastifyInstance): void {
  app.patch('/api/me', async (req, reply) => {
    const userId = req.user!.id;
    const { prefers_dark, preferred_lang, password, old_password, has_seen_tour, has_seen_email_tutorial, pinned_chains, emoji, email } = (req.body ?? {}) as {
      prefers_dark?: boolean; preferred_lang?: string; password?: string; old_password?: string; has_seen_tour?: boolean; has_seen_email_tutorial?: boolean; pinned_chains?: string[]; emoji?: string | null; email?: string | null;
    };

    const updates: Record<string, unknown> = {};
    if (prefers_dark !== undefined) updates.prefers_dark = prefers_dark;
    if (has_seen_tour !== undefined) updates.has_seen_tour = has_seen_tour;
    if (has_seen_email_tutorial !== undefined) updates.has_seen_email_tutorial = has_seen_email_tutorial;
    if (emoji !== undefined) updates.emoji = typeof emoji === 'string' && emoji.trim() ? emoji.trim().slice(0, 16) : null;
    if (email !== undefined) {
      const e = (email ?? '').trim();
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return reply.code(400).send({ error: 'invalid_email', message: 'Bitte eine gültige E-Mail-Adresse eingeben.' });
      // Lowercase on store (like signup, auth/routes.ts) so the case-sensitive `email TEXT UNIQUE`
      // constraint is effectively case-insensitive — a case-variant of an existing address then
      // hits 23505 → email_taken instead of creating a LOWER()-colliding duplicate that would make
      // login/forgot-password nondeterministic (they all match on LOWER(email)).
      updates.email = e ? e.toLowerCase().slice(0, 254) : null;
    }
    if (Array.isArray(pinned_chains)) updates.pinned_chains = pinned_chains.filter(s => typeof s === 'string').slice(0, 50);
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

    try {
      await sql`UPDATE users SET ${sql(updates)} WHERE id = ${userId}`;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ error: 'email_taken', message: 'Diese E-Mail-Adresse ist bereits vergeben.' });
      throw e;
    }
    return { ok: true };
  });

  /** Per-user notification preferences. Absence of a row = opted IN (default true).
   *  Currently only kind='reminders' (the monthly to-do reminders); push-only. */
  app.get('/api/me/notification-prefs', async (req) => {
    const rows = await sql`SELECT kind, push, email FROM notification_pref WHERE user_id = ${req.user!.id}`;
    return { prefs: rows };
  });

  app.put('/api/me/notification-prefs', async (req, reply) => {
    const { kind, push, email } = (req.body ?? {}) as { kind?: string; push?: boolean; email?: boolean };
    if (kind !== 'reminders') return reply.code(400).send({ error: 'unknown kind' });
    await sql`
      INSERT INTO notification_pref (user_id, kind, push, email, updated_at)
      VALUES (${req.user!.id}, ${kind}, ${push ?? true}, ${email ?? true}, NOW())
      ON CONFLICT (user_id, kind) DO UPDATE SET push = EXCLUDED.push, email = EXCLUDED.email, updated_at = NOW()`;
    return { ok: true };
  });
}
