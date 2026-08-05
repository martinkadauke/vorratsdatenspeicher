import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import sql, { DEMO_MODE } from '../db.js';
import { requireAdmin, requireOperator } from '../auth/plugin.js';
import { getAllConfig, setConfig, getConfig, isHouseholdConfigKey, scopeConfigForHousehold } from '../config.js';
import { rescheduleChurner } from '../churner/scheduler.js';
import { rescheduleSupermarket } from '../supermarket/scheduler.js';
import { rescheduleModelReview } from '../maintenance/modelReview.js';
import { rescheduleReminders, runReminders } from '../maintenance/reminders.js';
import { rescheduleDemoSweep } from '../maintenance/demoSweep.js';
import { rescheduleMailImport } from '../mail/scheduler.js';
import { rescheduleDropfolder } from '../dropfolder/scheduler.js';
import { runDropfolderImport, isDropfolderRunning } from '../dropfolder/importer.js';
import { listOllamaModels, ollamaHealth } from '../llm/ollama.js';
import { searxngHealth } from '../llm/searxng.js';
import { sendMail, sendMailWith, invalidateSmtpCheck, type SmtpSettings } from '../mailer.js';
import { inviteEmail, resetEmail, noticeEmail, setEmailBaseUrl } from '../email/templates.js';
import { createAuthToken } from '../auth/routes.js';
import { listModelsForProvider, listVisionModelsForProvider, healthForProvider, setTaskAi, type ProviderName, type AiTask } from '../llm/provider.js';
import { matchExistingCanonical } from '../lib/canonicalMatch.js';
import { claimDemoAi, aiLimitMessage } from '../demo/limits.js';

const VALID_PROVIDERS: ProviderName[] = ['ollama', 'deepseek', 'anthropic', 'openai'];

/** Where to top up credit per provider (Ollama is local → none). */
const TOP_UP_URL: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/billing',
  deepseek: 'https://platform.deepseek.com/top_up',
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
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
  { match: /gpt-4o-mini/i, in: 0.15, out: 0.6 },
  { match: /gpt-4o|chatgpt-4o/i, in: 2.5, out: 10 },
  { match: /gpt-4\.1-mini/i, in: 0.4, out: 1.6 },
  { match: /gpt-4\.1/i, in: 2, out: 8 },
  { match: /o4-mini|o3-mini/i, in: 1.1, out: 4.4 },
];
function estCostUsd(model: string, inTok: number, outTok: number): number {
  const p = PRICES.find(x => x.match.test(model));
  if (!p) return 0;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}
// Every configurable AI task — MUST stay in sync with the AiTask union (provider.ts). A task
// missing here makes PUT /api/ai/tasks/:task reject it with "invalid task", so the Admin
// provider/model change silently does nothing (that's what hid mailreinterpret/bankmatch/statsask).
const VALID_TASKS: AiTask[] = ['recategorize', 'churner_stage1', 'churner_stage2', 'ocr', 'categories_chat', 'model_review', 'nlanalytics', 'bankmatch', 'statsask', 'csvmapping', 'mailreinterpret'];

// ── update check (self-hosters) ───────────────────────────────────────────
// Upstream repo — a fork still gets upstream's release info, which is what a
// self-hoster wants to know about.
const RELEASES_URL = 'https://api.github.com/repos/martinkadauke/vorratsdatenspeicher/releases?per_page=30';
interface GhRelease { tag_name: string; name: string | null; body: string | null; html_url: string; published_at: string; draft: boolean; prerelease: boolean }
// In-memory so a restart just re-fetches; 6h TTL keeps us far under GitHub's
// unauthenticated 60 req/h even with several replicas.
let relCache: { at: number; releases: GhRelease[] } | null = null;
let relFailUntil = 0;                        // don't re-hit GitHub on every page load after a failure
const REL_TTL = 6 * 60 * 60 * 1000;
const REL_FAIL_BACKOFF = 15 * 60 * 1000;
/** Compare two semvers ("1.2.3" / "v1.2.3"). >0 → a is newer. */
function cmpSemver(a: string, b: string): number {
  const p = (s: string) => s.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  return 0;
}

export function adminRoutes(app: FastifyInstance): void {
  /** Is a newer STABLE release out than the one this container was built as?
   *  Only meaningful on a release image (APP_VERSION baked) — a dev-channel build
   *  reports channel:'dev' and never nags. `notes` carries every release newer than
   *  the running one, so the banner can show what was built since. */
  app.get('/api/update-check', { preHandler: requireOperator }, async () => {
    const raw = process.env.APP_VERSION || '';
    // Only a real semver counts as a release build — a self-hoster who pins
    // APP_VERSION=latest must not get a permanent "update available".
    const current = /^\d+\.\d+\.\d+$/.test(raw) ? raw : null;
    if (!current) return { channel: 'dev' as const, current: null, update_available: false, notes: [] };

    const now = Date.now();
    let err: string | null = null;
    if (!(relCache && now - relCache.at < REL_TTL) && now >= relFailUntil) {
      try {
        const res = await fetch(RELEASES_URL, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vds-update-check' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
        const json: unknown = await res.json();
        // A proxy/captive portal can answer 200 with a non-array body — caching that would
        // blow up .filter() below on every later request until the TTL expired.
        if (!Array.isArray(json)) throw new Error('unexpected GitHub payload');
        relCache = { at: now, releases: json as GhRelease[] };
      } catch (e) {
        // Offline / rate-limited / air-gapped: back off, and keep serving the stale cache
        // instead of discarding what we already knew.
        relFailUntil = now + REL_FAIL_BACKOFF;
        err = String((e as Error)?.message ?? e).slice(0, 120);
      }
    }
    const releases = relCache?.releases ?? null;
    if (!releases) return { channel: 'release' as const, current, update_available: false, notes: [], ...(err ? { error: err } : {}) };

    // Strict semver: a release someone forgot to flag as pre-release (1.2.0-rc1) must not
    // be treated as stable.
    const stable = releases.filter(r => !r.draft && !r.prerelease && /^v?\d+\.\d+\.\d+$/.test(r.tag_name));
    const newest = [...stable].sort((a, b) => cmpSemver(b.tag_name, a.tag_name))[0] ?? null;
    const newer = [...stable].filter(r => cmpSemver(r.tag_name, current) > 0)
      .sort((a, b) => cmpSemver(b.tag_name, a.tag_name));
    return {
      channel: 'release' as const,
      current,
      latest: newest ? newest.tag_name.replace(/^v/, '') : current,
      update_available: newer.length > 0,
      url: newest?.html_url ?? null,
      published_at: newest?.published_at ?? null,
      notes: newer.map(r => ({
        version: r.tag_name.replace(/^v/, ''),
        name: r.name ?? r.tag_name,
        body: (r.body ?? '').slice(0, 8000),
        published_at: r.published_at,
      })),
    };
  });

  // ── app config ──────────────────────────────────────────────────────────
  // requireAdmin stays (off-demo it is the only admin there is), but on the demo it buys nothing:
  // app_config is platform-global, so every key outside HOUSEHOLD_CONFIG_KEYS — today, every key
  // there is — is the operator's and is omitted rather than masked. A household admin therefore
  // gets `{}` here and 403 below; their own settings live on their `household` row instead
  // (PUT /api/onboarding/profile). See the allow-list comment in config.ts for why it is empty.
  app.get('/api/config', { preHandler: requireAdmin }, async (req) => {
    const cfg = await getAllConfig();
    return DEMO_MODE && !req.user?.is_super_admin ? scopeConfigForHousehold(cfg) : cfg;
  });

  app.put('/api/config/:key', { preHandler: requireAdmin }, async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const { value } = (req.body ?? {}) as { value?: unknown };
    // Demo: the SAME allow-list that scopes the read above — one predicate, so the two gates can
    // never drift apart again. With the list empty this is "super-admin only", which is the
    // honest gate for a table whose every row is shared by all tenants: `app.base_url` is the
    // link host in every invite/reset mail (a visitor who could set it would have the platform
    // hand-deliver live tokens to their domain), `offers.*`/`shopping.*` are the platform-wide
    // notification kill-switches, and `categories.detail` steers every household's category
    // prompt. Checked before anything else so the route fails closed.
    if (DEMO_MODE && !isHouseholdConfigKey(key) && !req.user?.is_super_admin) return reply.code(403).send({ error: 'forbidden' });
    if (value === undefined) return reply.code(400).send({ error: 'value required' });
    await setConfig(key, value, req.user!.id);
    if (key === 'app.base_url') setEmailBaseUrl(value as string);
    // The bug-report dialog asks /api/bug-reports/mail-status whether mail can go out, and that
    // verdict is cached for a minute — an operator who just fixed SMTP would otherwise keep being
    // told it is broken (and vice versa) while testing.
    if (key.startsWith('smtp.')) invalidateSmtpCheck();
    if (key.startsWith('churner.')) await rescheduleChurner();
    if (key.startsWith('supermarket.')) await rescheduleSupermarket();
    if (key.startsWith('model_review.')) await rescheduleModelReview();
    if (!DEMO_MODE && key.startsWith('reminders.')) await rescheduleReminders();   // no per-user reminders on demo
    if (!DEMO_MODE && key.startsWith('mailimport.')) await rescheduleMailImport();   // no IMAP on demo
    if (key.startsWith('dropfolder.')) await rescheduleDropfolder();
    if (DEMO_MODE && key.startsWith('demo_sweep.')) await rescheduleDemoSweep();
    return { ok: true };
  });

  /** Manual "scan now" for the drop-folder invoice importer → returns counts.
   *  requireOperator, not requireAdmin: this reads a path from the OPERATOR's config and
   *  vision-OCRs every file it finds there, uncapped. Off-demo requireOperator IS is_admin, so
   *  nothing changes; on the demo requireAdmin is satisfied by every visitor for their own
   *  household, which would hand a stranger both the operator's filesystem and an unbounded
   *  OCR burst. */
  app.post('/api/dropfolder/scan', { preHandler: requireOperator }, async () => {
    if (isDropfolderRunning()) return { running: true };
    return runDropfolderImport('manual');
  });

  /** Manual trigger for the monthly reminder batch (test/ops). `day` picks which reminder
   *  (1 = budgets, 7 = uploads, 15 = finish receipts) and BYPASSES the once-per-day claim,
   *  so it can be re-run. Off-demo only — reminders don't run on the demo. */
  app.post('/api/reminders/run', { preHandler: requireAdmin }, async (req, reply) => {
    if (DEMO_MODE) return reply.code(403).send({ error: 'reminders do not run on the demo' });
    const { day } = (req.body ?? {}) as { day?: number };
    const d = Number(day);
    if (![1, 7, 15].includes(d)) return reply.code(400).send({ error: 'day must be 1, 7 or 15' });
    return { ok: true, ...(await runReminders(d)) };
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

    // requireAdmin is RIGHT here — inviting into your own household is household business, and
    // the new users row lands in the caller's household via the GUC default. What is NOT
    // household business is the side effect: `email` is arbitrary, so on the demo this is an
    // uncapped VDS-branded mail blast over the operator's relay. Charge the shared demo bucket
    // like /api/analytics/report does — the operator's sending reputation burns as fast as their
    // tokens. Claimed BEFORE the insert so an exhausted bucket leaves no orphan users either.
    // Off-demo claimDemoQuota returns ok without touching the DB — a strict no-op.
    if (DEMO_MODE) {
      const claim = await claimDemoAi(req.user?.household_id);
      if (!claim.ok) return reply.code(429).send({ error: aiLimitMessage(claim.max) });
    }

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
    if (sees_all_konten !== undefined) {
      // "Sieht alles" (super-admin) is a privileged grant: only a super-admin may
      // change it, and never on their own account (no self-escalation/-lockout).
      if (id === req.user!.id) return reply.code(400).send({ error: 'cannot change your own super-admin status' });
      if (!req.user!.sees_all_konten) return reply.code(403).send({ error: 'only a super-admin can grant account-wide access' });
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
    // The recipient IS constrained here (the lookup is RLS-scoped to the caller's household), so
    // this is not an arbitrary-recipient relay — but it mints a token and sends a mail on every
    // call with no cap, so one throwaway address of your own is still an unbounded send loop on
    // the operator's SMTP. Same shared bucket as the invite above.
    if (DEMO_MODE) {
      const claim = await claimDemoAi(req.user?.household_id);
      if (!claim.ok) return reply.code(429).send({ error: aiLimitMessage(claim.max) });
    }
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
    // Target is RLS-scoped to the caller's household (they can already set that password via
    // PATCH /api/users/:id), so the link grants nothing new — the uncapped send on the operator's
    // relay is the cost. Meter it like the two invite sends above.
    if (DEMO_MODE) {
      const claim = await claimDemoAi(req.user?.household_id);
      if (!claim.ok) return reply.code(429).send({ error: aiLimitMessage(claim.max) });
    }
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
  /** requireOperator, not requireAdmin: `to` is fully caller-supplied and the mail goes out over
   *  the OPERATOR's relay under their smtp.from — on the demo requireAdmin is satisfied by every
   *  visitor, which makes this a fixed-body open relay and the fastest way to get the operator's
   *  sending domain blocklisted. The 502 body below (the raw transport error, which names the
   *  SMTP host and whether the credentials are valid) is why this is the guard rather than a
   *  quota: with requireOperator only the operator ever sees it, and they need the detail to
   *  debug. Off-demo requireOperator IS is_admin — byte-identical for self-hosters. */
  app.post('/api/smtp/test', { preHandler: requireOperator }, async (req, reply) => {
    const { to, settings } = (req.body ?? {}) as { to?: string; settings?: SmtpSettings };
    if (!to) return reply.code(400).send({ error: 'to required' });
    // `settings` = the fields as they stand in the dialog, unsaved. Testing them WITHOUT writing
    // them first is the whole point: the SMTP dialog is opened out of a half-written bug report
    // and promises that "Abbrechen" leaves the instance's mail server alone. Saving first (what
    // the client used to do) meant one trial run with a typo'd host silently broke invites,
    // password resets and the offer digest for everyone.
    const trial = settings?.host ? settings : null;
    try {
      const mail = noticeEmail({
        subject: 'Vorratsdatenspeicher – SMTP-Test',
        heading: 'SMTP funktioniert 🎉',
        body: 'Diese Test-E-Mail bestätigt, dass der E-Mail-Versand korrekt eingerichtet ist.',
      });
      if (trial) await sendMailWith(trial, to, mail.subject, mail.text, mail.html);
      else await sendMail(to, mail.subject, mail.text, mail.html);
      return { ok: true };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    } finally {
      // A test of the STORED config is the freshest evidence there is about this box's relay — in
      // both directions — so drop the cached verdict behind /api/bug-reports/mail-status. A trial
      // run of unsaved fields says nothing about the relay actually in use, and must not make the
      // bug-report dialog announce someone else's typo to every logged-in user.
      if (!trial) invalidateSmtpCheck();
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
  // All three are requireOperator, not requireAdmin: they probe the operator's INTERNAL hosts
  // (ollama.url / searxng.url) and hand back the model inventory, the server version and — on
  // failure — the raw fetch error, which names the LAN host and port. Nothing here is a household
  // feature; these predate the operator split and their /api/ai/* siblings below are already
  // requireOperator, as is the AiProvidersSection that calls them. Free off-demo (is_admin).
  app.get('/api/ollama/models', { preHandler: requireOperator }, async (req, reply) => {
    try {
      return { models: await listOllamaModels() };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/ollama/health', { preHandler: requireOperator }, async () => ollamaHealth());
  app.get('/api/searxng/health', { preHandler: requireOperator }, async () => searxngHealth());

  // ── AI providers (Ollama + DeepSeek) ────────────────────────────────────
  app.get('/api/ai/providers', { preHandler: requireOperator }, async () => ({
    providers: VALID_PROVIDERS,
    tasks: VALID_TASKS,
  }));

  app.get('/api/ai/models', { preHandler: requireOperator }, async (req, reply) => {
    const q = req.query as { provider?: string; vision?: string };
    const provider = q.provider as ProviderName | undefined;
    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({ error: 'invalid provider' });
    }
    try {
      const models = q.vision === '1'
        ? await listVisionModelsForProvider(provider)
        : await listModelsForProvider(provider);
      return { models };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/ai/health', { preHandler: requireOperator }, async (req, reply) => {
    const provider = (req.query as { provider?: string }).provider as ProviderName | undefined;
    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({ error: 'invalid provider' });
    }
    return healthForProvider(provider);
  });

  /** Set provider+model for one task atomically. */
  app.put('/api/ai/tasks/:task', { preHandler: requireOperator }, async (req, reply) => {
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
  app.get('/api/ai/usage', { preHandler: requireOperator }, async () => {
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
   *  report how often the matcher reproduces the assigned canonical.
   *  requireOperator: a diagnostics harness with no UI caller, and an unpaginated
   *  O(articles × distinct canonicals) scan — on the demo requireAdmin made it a
   *  free CPU sink on the shared container for anyone who bulk-created articles. */
  app.get('/api/admin/canonical-match-test', { preHandler: requireOperator }, async () => {
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
  app.get('/api/ai/tasks/log', { preHandler: requireOperator }, async (req) => {
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
