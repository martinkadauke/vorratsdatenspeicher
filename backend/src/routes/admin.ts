import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { getAllConfig, setConfig, getConfig } from '../config.js';
import { rescheduleChurner } from '../churner/scheduler.js';
import { rescheduleSupermarket } from '../supermarket/scheduler.js';
import { rescheduleModelReview } from '../maintenance/modelReview.js';
import { listOllamaModels, ollamaHealth } from '../llm/ollama.js';
import { searxngHealth } from '../llm/searxng.js';
import { sendMail } from '../mailer.js';
import { inviteEmail, resetEmail, noticeEmail } from '../email/templates.js';
import { createAuthToken } from '../auth/routes.js';
import { listModelsForProvider, healthForProvider, setTaskAi, type ProviderName, type AiTask } from '../llm/provider.js';
import { matchExistingCanonical } from '../lib/canonicalMatch.js';

const VALID_PROVIDERS: ProviderName[] = ['ollama', 'deepseek', 'anthropic'];

/** Where to top up credit per provider (Ollama is local → none). */
const TOP_UP_URL: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  deepseek: 'https://platform.deepseek.com/top_up',
};

/** Rough public list prices in USD per 1M tokens [input, output], matched by
 *  substring of the model name. Local (Ollama) and unknown models → no cost.
 *  Estimate only — providers bill the authoritative amount. */
const PRICES: { match: RegExp; in: number; out: number }[] = [
  { match: /opus/i, in: 15, out: 75 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /haiku/i, in: 0.8, out: 4 },
  { match: /deepseek-(reasoner|r1)/i, in: 0.55, out: 2.19 },
  { match: /deepseek/i, in: 0.27, out: 1.1 },
];
function estCostUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICES.find(x => x.match.test(model));
  if (!p) return 0;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}
const VALID_TASKS: AiTask[] = ['recategorize', 'churner_stage1', 'churner_stage2', 'ocr', 'categories_chat', 'model_review'];

export function adminRoutes(app: FastifyInstance): void {
  // ── app config ──────────────────────────────────────────────────────────
  app.get('/api/config', { preHandler: requireAdmin }, async () => getAllConfig());

  app.put('/api/config/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const { value } = (req.body ?? {}) as { value?: unknown };
    if (value === undefined) return reply.code(400).send({ error: 'value required' });
    await setConfig(key, value, req.user!.id);
    if (key.startsWith('churner.')) await rescheduleChurner();
    if (key.startsWith('supermarket.')) await rescheduleSupermarket();
    if (key.startsWith('model_review.')) await rescheduleModelReview();
    return { ok: true };
  });

  // ── users (invite-only) ─────────────────────────────────────────────────
  app.get('/api/users', { preHandler: requireAdmin }, async () => {
    return sql`
      SELECT u.id, u.username, u.email, u.is_admin, u.sees_all_konten, u.can_write, u.prefers_dark, u.preferred_lang, u.created_at,
        EXISTS (
          SELECT 1 FROM auth_token t
          WHERE t.user_id = u.id AND t.kind = 'invite' AND t.used_at IS NULL AND t.expires_at > NOW()
        ) AS invite_pending,
        (
          EXISTS (SELECT 1 FROM auth_token t WHERE t.user_id = u.id AND t.kind = 'invite')
          AND NOT EXISTS (SELECT 1 FROM auth_token t WHERE t.user_id = u.id AND t.kind = 'invite' AND t.used_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM auth_token t WHERE t.user_id = u.id AND t.kind = 'invite' AND t.used_at IS NULL AND t.expires_at > NOW())
        ) AS invite_expired
      FROM users u
      ORDER BY u.id`;
  });

  /** Invite a new user by email. Username is derived from the email's
   *  local-part (collision-suffixed if necessary). Random password is
   *  set under the hood; the invite link lets them choose their own. */
  app.post('/api/users/invite', { preHandler: requireAdmin }, async (req, reply) => {
    const { email, is_admin, can_write } = (req.body ?? {}) as { email?: string; is_admin?: boolean; can_write?: boolean };
    if (!email || !email.includes('@')) return reply.code(400).send({ error: 'valid email required' });

    const cleaned = email.trim().toLowerCase();
    const base = cleaned.split('@')[0].replace(/[^a-z0-9._-]/gi, '') || 'user';
    let username = base;
    for (let n = 2; n < 100; n++) {
      const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE LOWER(username) = ${username}`;
      if (count === 0) break;
      username = `${base}${n}`;
    }

    const randomHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    let userId: number;
    try {
      const [row] = await sql`
        INSERT INTO users (username, email, password_hash, is_admin, can_write)
        VALUES (${username}, ${cleaned}, ${randomHash}, ${is_admin ?? false}, ${can_write ?? true})
        RETURNING id
      `;
      userId = row.id;
    } catch {
      return reply.code(409).send({ error: 'email already exists' });
    }

    const token = await createAuthToken(userId, 'invite', 7 * 24);
    const baseUrl = await getConfig('app.base_url');
    const link = `${baseUrl}/reset?token=${token}`;

    let emailed = false;
    try {
      const mail = inviteEmail({ username, link });
      await sendMail(cleaned, mail.subject, mail.text, mail.html);
      emailed = true;
    } catch (e) {
      req.log.warn(`invite mail failed: ${(e as Error).message}`);
    }

    return { ok: true, id: userId, username, emailed, invite_link: link };
  });

  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { is_admin, password, email, sees_all_konten, can_write } = (req.body ?? {}) as {
      is_admin?: boolean; password?: string; email?: string; sees_all_konten?: boolean; can_write?: boolean;
    };

    if (is_admin === false && id === req.user!.id) {
      return reply.code(400).send({ error: 'cannot demote yourself' });
    }
    if (can_write === false && id === req.user!.id) {
      return reply.code(400).send({ error: 'cannot remove your own write access' });
    }
    const updates: Record<string, unknown> = {};
    if (is_admin !== undefined) updates.is_admin = is_admin;
    if (sees_all_konten !== undefined) updates.sees_all_konten = sees_all_konten;
    if (can_write !== undefined) updates.can_write = can_write;
    if (password) updates.password_hash = await bcrypt.hash(password, 12);
    if (email !== undefined) updates.email = email || null;
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    await sql`UPDATE users SET ${sql(updates)} WHERE id = ${id}`;
    return { ok: true };
  });

  /** Resend an invite link to a user who hasn't accepted yet (fresh 7-day token). */
  app.post('/api/users/:id/resend-invite', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const rows = await sql`SELECT username, email FROM users WHERE id = ${id}`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    if (!rows[0].email) return reply.code(400).send({ error: 'user has no email' });
    const token = await createAuthToken(id, 'invite', 7 * 24);
    const baseUrl = await getConfig('app.base_url');
    const link = `${baseUrl}/reset?token=${token}`;
    let emailed = false;
    try {
      const mail = inviteEmail({ username: rows[0].username as string, link });
      await sendMail(rows[0].email as string, mail.subject, mail.text, mail.html);
      emailed = true;
    } catch (e) {
      req.log.warn(`resend-invite mail failed: ${(e as Error).message}`);
    }
    return { ok: true, emailed, invite_link: link };
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
        const mail = resetEmail({ username: rows[0].username as string, link, validity: '24 Stunden' });
        await sendMail(rows[0].email as string, mail.subject, mail.text, mail.html);
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
      const mail = noticeEmail({
        subject: 'Vorratsdatenspeicher – SMTP-Test',
        heading: 'SMTP funktioniert 🎉',
        body: 'Diese Test-E-Mail bestätigt, dass der E-Mail-Versand korrekt eingerichtet ist.',
      });
      await sendMail(to, mail.subject, mail.text, mail.html);
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (id === req.user!.id) return reply.code(400).send({ error: 'cannot delete yourself' });
    // Last-admin protection: don't allow deleting the last admin
    if (req.user!.is_admin) {
      const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE is_admin = TRUE`;
      const [target] = await sql`SELECT is_admin FROM users WHERE id = ${id}`;
      if (count <= 1 && target?.is_admin) {
        return reply.code(400).send({ error: 'cannot delete the last admin' });
      }
    }
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

  // ── AI providers (Ollama + DeepSeek) ────────────────────────────────────
  app.get('/api/ai/providers', { preHandler: requireAdmin }, async () => ({
    providers: VALID_PROVIDERS,
    tasks: VALID_TASKS,
  }));

  app.get('/api/ai/models', { preHandler: requireAdmin }, async (req, reply) => {
    const provider = (req.query as { provider?: string }).provider as ProviderName | undefined;
    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({ error: 'invalid provider' });
    }
    try {
      return { models: await listModelsForProvider(provider) };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/ai/health', { preHandler: requireAdmin }, async (req, reply) => {
    const provider = (req.query as { provider?: string }).provider as ProviderName | undefined;
    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({ error: 'invalid provider' });
    }
    return healthForProvider(provider);
  });

  /** Set provider+model for one task atomically. */
  app.put('/api/ai/tasks/:task', { preHandler: requireAdmin }, async (req, reply) => {
    const task = (req.params as { task: string }).task as AiTask;
    if (!VALID_TASKS.includes(task)) return reply.code(400).send({ error: 'invalid task' });
    const { provider, model } = (req.body ?? {}) as { provider?: ProviderName; model?: string };
    if (!provider || !VALID_PROVIDERS.includes(provider) || !model) {
      return reply.code(400).send({ error: 'provider and model required' });
    }
    await setTaskAi(task, provider, model, req.user!.id);
    return { ok: true };
  });

  /** Token-usage analytics: consumption per provider/model/task + a daily
   *  series, with a rough cost estimate and top-up links per provider. */
  app.get('/api/ai/usage', { preHandler: requireAdmin }, async () => {
    const grouped = await sql`
      SELECT provider, model, task,
             COUNT(*)::int            AS calls,
             SUM(input_tokens)::bigint  AS input_tokens,
             SUM(output_tokens)::bigint AS output_tokens
      FROM ai_usage
      GROUP BY provider, model, task
    `;
    const daily = await sql`
      SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
             SUM(input_tokens)::bigint  AS input_tokens,
             SUM(output_tokens)::bigint AS output_tokens,
             COUNT(*)::int             AS calls
      FROM ai_usage
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day
    `;

    type Agg = { calls: number; input_tokens: number; output_tokens: number; est_cost_usd: number };
    const blank = (): Agg => ({ calls: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 });
    const byProvider = new Map<string, Agg>();
    const byTask = new Map<string, Agg>();
    const byModel: { provider: string; model: string; calls: number; input_tokens: number; output_tokens: number; est_cost_usd: number }[] = [];
    const totals = blank();

    for (const r of grouped) {
      const inTok = Number(r.input_tokens) || 0;
      const outTok = Number(r.output_tokens) || 0;
      const calls = r.calls as number;
      const cost = estCostUsd(r.model as string, inTok, outTok);
      const add = (m: Map<string, Agg>, key: string) => {
        const a = m.get(key) ?? blank();
        a.calls += calls; a.input_tokens += inTok; a.output_tokens += outTok; a.est_cost_usd += cost;
        m.set(key, a);
      };
      add(byProvider, r.provider as string);
      add(byTask, r.task as string);
      byModel.push({ provider: r.provider as string, model: r.model as string, calls, input_tokens: inTok, output_tokens: outTok, est_cost_usd: cost });
      totals.calls += calls; totals.input_tokens += inTok; totals.output_tokens += outTok; totals.est_cost_usd += cost;
    }

    return {
      totals,
      byProvider: [...byProvider.entries()].map(([provider, a]) => ({ provider, ...a, top_up_url: TOP_UP_URL[provider] ?? null }))
        .sort((a, b) => b.est_cost_usd - a.est_cost_usd || b.input_tokens - a.input_tokens),
      byModel: byModel.sort((a, b) => b.est_cost_usd - a.est_cost_usd || b.input_tokens - a.input_tokens),
      byTask: [...byTask.entries()].map(([task, a]) => ({ task, ...a })).sort((a, b) => b.calls - a.calls),
      daily: daily.map(d => ({ day: d.day, input_tokens: Number(d.input_tokens) || 0, output_tokens: Number(d.output_tokens) || 0, calls: d.calls })),
    };
  });

  /** Validation: run the deterministic canonical matcher against every article
   *  that already has a canonical name (using its OCR/name/guess texts) and
   *  report how often the matcher reproduces the assigned canonical. */
  app.get('/api/admin/canonical-match-test', { preHandler: requireAdmin }, async () => {
    const rows = await sql`SELECT original_text, name, ai_guess, canonical_name FROM artikel WHERE canonical_name IS NOT NULL`;
    const existing = [...new Set(rows.map(r => r.canonical_name as string))];
    let hit = 0, missNull = 0, diff = 0;
    const diffSamples: { texts: string; assigned: string; matched: string }[] = [];
    const nullSamples: { texts: string; assigned: string }[] = [];
    for (const r of rows) {
      const m = matchExistingCanonical([r.original_text, r.name, r.ai_guess], existing);
      const assigned = r.canonical_name as string;
      if (m === assigned) hit++;
      else if (m === null) { missNull++; if (nullSamples.length < 30) nullSamples.push({ texts: `${r.original_text ?? ''} | ${r.ai_guess ?? ''}`, assigned }); }
      else { diff++; if (diffSamples.length < 30) diffSamples.push({ texts: `${r.original_text ?? ''} | ${r.ai_guess ?? ''}`, assigned, matched: m }); }
    }
    const total = rows.length;
    return {
      total, distinct_canonicals: existing.length,
      hit, hitRate: total ? +(hit / total * 100).toFixed(1) : 0,
      missNull, diff,
      nullSamples, diffSamples,
    };
  });

  /** Model-change history: who set which provider/model for which task, when. */
  app.get('/api/ai/tasks/log', { preHandler: requireAdmin }, async (req) => {
    const limit = Math.min(parseInt((req.query as { limit?: string }).limit ?? '50', 10) || 50, 200);
    return sql`
      SELECT l.id, l.task, l.provider, l.model, l.source, l.changed_at, u.username AS changed_by
      FROM ai_task_log l
      LEFT JOIN users u ON u.id = l.changed_by
      ORDER BY l.id DESC
      LIMIT ${limit}
    `;
  });
}
