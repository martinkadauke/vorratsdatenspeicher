import type { FastifyInstance } from 'fastify';
import sql, { adminSql, DEMO_MODE } from '../db.js';
import { requireAdmin, requirePlatformAdmin } from '../auth/plugin.js';
import { runDemoSweep } from '../maintenance/demoSweep.js';
import { sendMail } from '../mailer.js';
import { feedbackEmail } from '../email/templates.js';

/** Demo-only routes: user bug reports + platform super-admin household management. */
export function demoRoutes(app: FastifyInstance): void {
  // Defense-in-depth: this module registers DESTRUCTIVE household-management routes
  // (POST /api/households/wipe-all and DELETE /api/households/:id). They must never exist
  // outside DEMO_MODE. index.ts already gates the mount with `if (DEMO_MODE)`, but assert
  // here too so a future refactor that mounts this unconditionally registers NOTHING off-demo
  // rather than silently exposing a data-delete route.
  if (!DEMO_MODE) { console.error('[demo] demoRoutes() invoked with DEMO_MODE off — refusing to register demo routes'); return; }

  // ── Bug report — any authenticated user ─────────────────────────────────
  app.post('/api/bug-reports', async (req, reply) => {
    const { message, page } = (req.body ?? {}) as { message?: string; page?: string };
    if (!message || !message.trim()) return reply.code(400).send({ error: 'message required' });
    const ctx = {
      page: (page ?? '').slice(0, 300),
      household_id: req.user?.household_id ?? null,
      ua: String(req.headers['user-agent'] ?? '').slice(0, 300),
    };
    // bug_report is global (no RLS) → the ambient connection inserts fine regardless of scope.
    await sql`INSERT INTO bug_report (user_id, message, context) VALUES (${req.user?.id ?? null}, ${message.trim().slice(0, 5000)}, ${sql.json(ctx)})`;
    // Forward to the operator (fire-and-forget; never blocks the report).
    void (async () => {
      try {
        const mail = feedbackEmail({ message: message.trim(), page: ctx.page, from: req.user?.email ?? req.user?.username ?? 'anonym', householdId: req.user?.household_id ?? null });
        await sendMail('webmaster@vorratsdatenspeicher.com', mail.subject, mail.text, mail.html, req.user?.email ?? undefined);
      } catch (err) { req.log.error(`feedback mail failed: ${(err as Error).message}`); }
    })();
    return { ok: true };
  });

  // ── Onboarding: per-household completion + slim-wizard profile ───────────
  /** Mark THIS household's first-run wizard done (per-household, not global config). */
  app.post('/api/onboarding/complete', { preHandler: requireAdmin }, async (req) => {
    await adminSql`UPDATE household SET onboarding_done = TRUE WHERE id = ${req.user!.household_id ?? 1}`;
    return { ok: true };
  });

  /** Demo household admins persist their slim-onboarding answers to their OWN household
   *  row (address + category granularity) — never the global operator config. */
  app.put('/api/onboarding/profile', { preHandler: requireAdmin }, async (req) => {
    const { address, categories_detail } = (req.body ?? {}) as { address?: string; categories_detail?: string };
    const hid = req.user!.household_id ?? 1;
    if (typeof address === 'string') await adminSql`UPDATE household SET address = ${address.slice(0, 200)} WHERE id = ${hid}`;
    if (typeof categories_detail === 'string') await adminSql`UPDATE household SET categories_detail = ${categories_detail.slice(0, 20)} WHERE id = ${hid}`;
    return { ok: true };
  });

  // ── Platform super-admin: bug reports across all households ──────────────
  app.get('/api/bug-reports', { preHandler: requirePlatformAdmin }, async () =>
    adminSql`
      SELECT b.id, b.message, b.context, b.status, b.created_at, u.username, u.email
      FROM bug_report b LEFT JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC LIMIT 500`);

  app.patch('/api/bug-reports/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { status } = (req.body ?? {}) as { status?: string };
    if (!status) return reply.code(400).send({ error: 'status required' });
    await adminSql`UPDATE bug_report SET status = ${status} WHERE id = ${id}`;
    return { ok: true };
  });

  // ── Platform super-admin: household management ───────────────────────────
  app.get('/api/households', { preHandler: requirePlatformAdmin }, async () =>
    adminSql`
      SELECT h.id, h.name, h.created_at,
             (SELECT count(*)::int FROM users u   WHERE u.household_id   = h.id) AS users,
             (SELECT count(*)::int FROM einkauf e WHERE e.household_id   = h.id) AS receipts,
             (SELECT count(*)::int FROM artikel a WHERE a.household_id   = h.id) AS articles
      FROM household h ORDER BY h.id`);

  /** Wipe ALL user-generated (ephemeral, is_demo) households NOW — every row + every
   *  file (receipt photos + pay-slips). Same op as the nightly sweep, on demand. */
  app.post('/api/households/wipe-all', { preHandler: requirePlatformAdmin }, async () => runDemoSweep());

  /** Delete a household and ALL its data. Household 1 (the platform/super-admin household)
   *  is protected. Uses session_replication_role=replica (owner is superuser) to delete
   *  across all tenant tables without fighting inter-table foreign keys. */
  app.delete('/api/households/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!Number.isFinite(id) || id <= 1) return reply.code(400).send({ error: 'cannot delete this household' });
    const [h] = await adminSql`SELECT id FROM household WHERE id = ${id}`;
    if (!h) return reply.code(404).send({ error: 'not found' });

    const tables = await adminSql`
      SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'household_id' AND t.table_type = 'BASE TABLE'`;
    await adminSql.begin(async tx => {
      await tx`SET LOCAL session_replication_role = replica`;
      for (const { table_name } of tables) {
        await tx.unsafe(`DELETE FROM "${table_name}" WHERE household_id = $1`, [id]);
      }
      await tx`DELETE FROM household WHERE id = ${id}`;
    });
    return { ok: true };
  });
}
