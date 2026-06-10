import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { getAllConfig, setConfig } from '../config.js';
import { rescheduleChurner } from '../churner/scheduler.js';
import { listOllamaModels, ollamaHealth } from '../llm/ollama.js';
import { searxngHealth } from '../llm/searxng.js';

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

  // ── users ───────────────────────────────────────────────────────────────
  app.get('/api/users', { preHandler: requireAdmin }, async () => {
    return sql`SELECT id, username, is_admin, prefers_dark, preferred_lang, created_at FROM users ORDER BY id`;
  });

  app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
    const { username, password, is_admin } = (req.body ?? {}) as {
      username?: string; password?: string; is_admin?: boolean;
    };
    if (!username || !password) return reply.code(400).send({ error: 'username and password required' });
    const hash = await bcrypt.hash(password, 12);
    try {
      const [row] = await sql`
        INSERT INTO users (username, password_hash, is_admin)
        VALUES (${username}, ${hash}, ${is_admin ?? false})
        RETURNING id
      `;
      return { ok: true, id: row.id };
    } catch {
      return reply.code(409).send({ error: 'username already exists' });
    }
  });

  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { is_admin, password } = (req.body ?? {}) as { is_admin?: boolean; password?: string };

    if (is_admin === false && id === req.user!.id) {
      return reply.code(400).send({ error: 'cannot demote yourself' });
    }
    const updates: Record<string, unknown> = {};
    if (is_admin !== undefined) updates.is_admin = is_admin;
    if (password) updates.password_hash = await bcrypt.hash(password, 12);
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    await sql`UPDATE users SET ${sql(updates)} WHERE id = ${id}`;
    return { ok: true };
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
