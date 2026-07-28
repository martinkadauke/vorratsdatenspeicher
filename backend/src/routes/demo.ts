import type { FastifyInstance } from 'fastify';
import { adminSql, DEMO_MODE } from '../db.js';
import { requireAdmin, requirePlatformAdmin } from '../auth/plugin.js';
import { runDemoSweep } from '../maintenance/demoSweep.js';
import { applyDemoTree, asTreeKey } from '../demo/seedHousehold.js';

/** Demo-only routes: onboarding profile + platform super-admin household management.
 *  (Bug-report routes moved to routes/feedback.ts so they exist in all builds.) */
export function demoRoutes(app: FastifyInstance): void {
  // Defense-in-depth: this module registers DESTRUCTIVE household-management routes
  // (POST /api/households/wipe-all and DELETE /api/households/:id). They must never exist
  // outside DEMO_MODE. index.ts already gates the mount with `if (DEMO_MODE)`, but assert
  // here too so a future refactor that mounts this unconditionally registers NOTHING off-demo
  // rather than silently exposing a data-delete route.
  if (!DEMO_MODE) { console.error('[demo] demoRoutes() invoked with DEMO_MODE off — refusing to register demo routes'); return; }

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
    if (typeof categories_detail === 'string') {
      await adminSql`UPDATE household SET categories_detail = ${categories_detail.slice(0, 20)} WHERE id = ${hid}`;
      // Swap in the matching curated tree and re-point the seeded receipts to their
      // pre-computed categories for it. Deterministic and free — no AI tokens, which
      // matters when anyone on the internet can create a household.
      try { await applyDemoTree(hid, asTreeKey(categories_detail)); }
      catch (e) { req.log.error(`demo tree apply failed: ${(e as Error).message}`); }
    }
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
