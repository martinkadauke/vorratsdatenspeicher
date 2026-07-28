import './env.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import './types.js';
import sql, { adminSql, DEMO_MODE, migrate, ensureAdmin, ensureCashKonten, ensureAppRole, assertRlsCoverage, assertDemoDb } from './db.js';
import { initSearch } from './lib/search.js';
import { backfillAliases, backfillArtikelOcrKey } from './lib/canonicalAlias.js';
import { PORT, getConfig } from './config.js';
import { setEmailBaseUrl } from './email/templates.js';
import { registerAuth } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { receiptRoutes } from './routes/receipts.js';
import { articleRoutes } from './routes/articles.js';
import { categoryRoutes } from './routes/categories.js';
import { familyRoutes } from './routes/family.js';
import { spendingRoutes } from './routes/spending.js';
import { goalRoutes } from './routes/goals.js';
import { pantryRoutes } from './routes/pantry.js';
import { nameRoutes } from './routes/names.js';
import { pushRoutes } from './routes/push.js';
import { queueRoutes } from './routes/queue.js';
import { pruefenRoutes } from './routes/pruefen.js';
import { pruefenUnitRoutes } from './routes/pruefenUnits.js';
import { notificationRoutes } from './routes/notifications.js';
import { adminRoutes } from './routes/admin.js';
import { meRoutes } from './routes/me.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { i18nRoutes } from './routes/i18n.js';
import { exportRoutes } from './routes/exports.js';
import { backupRoutes } from './routes/backup.js';
import { storeRoutes } from './routes/stores.js';
import { trendsRoutes } from './routes/trends.js';
import { iconRoutes } from './routes/icons.js';
import { kontoRoutes } from './routes/konten.js';
import { financeRoutes } from './routes/finances.js';
import { unitRoutes } from './routes/units.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { offerRoutes } from './routes/offers.js';
import { rescheduleChurner } from './churner/scheduler.js';
import { rescheduleSupermarket } from './supermarket/scheduler.js';
import { rescheduleModelReview } from './maintenance/modelReview.js';
import { rescheduleMailImport } from './mail/scheduler.js';
import { rescheduleDropfolder } from './dropfolder/scheduler.js';
import { modelReviewRoutes } from './routes/modelReview.js';
import { analyticsRoutes } from './routes/analytics.js';
import { mailboxRoutes } from './routes/mailbox.js';
import { demoRoutes } from './routes/demo.js';
import { feedbackRoutes } from './routes/feedback.js';
import { rescheduleDemoSweep } from './maintenance/demoSweep.js';

/** Wait for Postgres to accept connections before the first query. The app container often
 *  starts faster than its database — and on a fresh volume the official postgres image briefly
 *  passes `pg_isready` DURING initdb, then restarts, so even `depends_on: service_healthy` can
 *  hand us a socket that's about to drop (→ "connection refused" crash-loop). Retrying here makes
 *  boot robust regardless of compose wiring. Bounded by DB_WAIT_MS (default 90s) so a genuine
 *  misconfiguration still fails loudly instead of hanging forever. */
async function waitForDb(): Promise<void> {
  const maxMs = Number(process.env.DB_WAIT_MS ?? 90000);
  const started = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      await adminSql`SELECT 1`;
      if (attempt > 0) console.log(`[boot] database ready after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}`);
      return;
    } catch (err) {
      attempt++;
      if (Date.now() - started > maxMs) {
        console.error(`[boot] database unreachable after ${Math.round((Date.now() - started) / 1000)}s — giving up`);
        throw err;
      }
      const wait = Math.min(2000, 250 * attempt);
      console.warn(`[boot] waiting for database (attempt ${attempt}): ${(err as Error).message} — retry in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

async function main(): Promise<void> {
  // The DB container may still be starting (or mid-initdb) — wait before the first query so a
  // slow Postgres doesn't crash-loop the app with "connection refused".
  await waitForDb();
  // Demo boot interlock runs BEFORE migrate() so demo migrations/RLS can never touch a
  // mis-targeted (single-role dev/prod) database.
  if (DEMO_MODE) assertDemoDb();
  await migrate();
  if (DEMO_MODE) { await ensureAppRole(); await assertRlsCoverage(); }
  await ensureAdmin();
  await ensureCashKonten();
  await initSearch();
  await backfillAliases();
  await backfillArtikelOcrKey();

  // Sweep any maintenance events left "running" by a previous container that
  // died mid-loop. Without this they'd block new runs forever (running flag
  // resets on restart but the row stays unfinished).
  // Boot cleanups run on the owner connection (adminSql) so they cross all households in
  // the demo; non-demo, adminSql === the pool, so this is the original behaviour.
  await adminSql`
    UPDATE maintenance_event
    SET status = 'interrupted', ended_at = NOW(),
        summary = COALESCE(summary, '{}'::jsonb) || ${adminSql.json({ interrupted_by: 'container_restart' })}
    WHERE status = 'running'
  `;
  await adminSql`UPDATE einkauf SET ocr_pending = FALSE WHERE ocr_pending = TRUE`;
  await adminSql`DELETE FROM imported_email WHERE status = 'processing' AND created_at < NOW() - INTERVAL '1 hour'`;

  const app = Fastify({ logger: { level: 'info' } });

  registerAuth(app);

  // Liveness only — process responds. DB-Verbindung wird beim Start migrate() validiert,
  // wenn die DB später langsam ist sollen NICHT alle Replicas gleichzeitig sterben.
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/ready', async () => {
    const [row] = await sql`SELECT 1 AS ok`;
    return { ok: row.ok === 1 };
  });
  app.get('/api/version', async () => ({
    sha: process.env.GIT_SHA ?? 'unknown',
    ref: process.env.GIT_REF ?? 'unknown',
    // Semver on a RELEASE image (baked by the release workflow); null on dev builds.
    version: process.env.APP_VERSION || null,
    // Runtime env (prod/stage/dev), injected at deploy time — reliable even when
    // several branches share a commit SHA (and thus the same baked image/GIT_REF).
    env: process.env.VDS_ENV ?? null,
    demo: DEMO_MODE,
    // Off-demo only: true until the first-run wizard is completed. The login page reads this
    // to show a fresh self-hoster the default-credentials hint so they can get in and reach
    // the setup wizard (which then flips onboarding.done → this goes false, hint disappears).
    needs_setup: DEMO_MODE ? false : !(await getConfig('onboarding.done')),
    node: process.version,
    started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  }));

  authRoutes(app);
  receiptRoutes(app);
  articleRoutes(app);
  categoryRoutes(app);
  familyRoutes(app);
  spendingRoutes(app);
  goalRoutes(app);
  pantryRoutes(app);
  nameRoutes(app);
  queueRoutes(app);
  pruefenRoutes(app);
  pruefenUnitRoutes(app);
  notificationRoutes(app);
  adminRoutes(app);
  meRoutes(app);
  maintenanceRoutes(app);
  i18nRoutes(app);
  exportRoutes(app);
  backupRoutes(app);
  storeRoutes(app);
  trendsRoutes(app);
  iconRoutes(app);
  kontoRoutes(app);
  financeRoutes(app);
  unitRoutes(app);
  subscriptionRoutes(app);
  offerRoutes(app);
  modelReviewRoutes(app);
  analyticsRoutes(app);
  // No mailbox/IMAP on the public demo: a visitor would be typing REAL e-mail credentials
  // into a throwaway box anyone can sign up for, and every imported attachment is a vision-OCR
  // call on the operator's account. Not registered at all — the endpoints simply don't exist.
  if (!DEMO_MODE) mailboxRoutes(app);
  pushRoutes(app);
  feedbackRoutes(app); // bug-report/feedback — available in all builds (header button)
  if (DEMO_MODE) demoRoutes(app);

  const receiptsDir = process.env.RECEIPTS_LOCAL_PATH ?? '/receipts';

  // Static SPA. Vite emits content-hashed assets under /assets/* (safe to cache
  // forever), but index.html points at the current hashes and MUST always be
  // revalidated — otherwise a browser keeps loading an old bundle after a deploy
  // (the cause of "I don't see the new feature" / stale-data ghosts).
  const publicDir = path.join(process.cwd(), 'public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      wildcard: false,
      cacheControl: false, // we set Cache-Control ourselves below so index.html can opt out
      setHeaders(res, filePath) {
        res.setHeader(
          'Cache-Control',
          filePath.endsWith('index.html')
            ? 'no-cache, must-revalidate'         // always revalidate the entry point
            : 'public, max-age=31536000, immutable', // content-hashed assets never change
        );
      },
    });

    // Receipt photos live at /receipts/<file>.jpg, which shares the path space
    // with the SPA route /receipts/:id. Serve a photo ONLY when the file really
    // exists; anything else (e.g. a hard reload of /receipts/98) falls through to
    // the SPA index.html via the not-found handler below. Reuses the static
    // plugin's reply.sendFile with a root override (no second decorator).
    if (existsSync(receiptsDir)) {
      app.get('/receipts/:file', (req, reply) => {
        const file = (req.params as { file: string }).file;
        const full = path.join(receiptsDir, file);
        if (file.includes('..') || file.includes('/') || file.includes('\\')
            || !existsSync(full) || !statSync(full).isFile()) {
          return reply.callNotFound();
        }
        return reply.sendFile(file, receiptsDir);
      });
      app.log.info(`serving receipt photos from ${receiptsDir}`);
    } else {
      app.log.warn(`no receipts dir at ${receiptsDir} — photo serving disabled`);
    }

    // Example receipts for the public demo (seeded households + the first-run scan).
    // Bundled in the image but served ONLY when DEMO_MODE is on: dev/stage/prod and every
    // self-host install 404 here, so these photos are unreachable outside the demo.
    // Deliberately NOT under /receipts — demoSweep unlinks files there by basename.
    const demoAssetsDir = process.env.DEMO_ASSETS_PATH ?? path.join(process.cwd(), 'demo-assets');
    if (DEMO_MODE && existsSync(demoAssetsDir)) {
      app.get('/demo-receipts/:file', (req, reply) => {
        const file = (req.params as { file: string }).file;
        const full = path.join(demoAssetsDir, file);
        if (file.includes('..') || file.includes('/') || file.includes('\\')
            || !existsSync(full) || !statSync(full).isFile()) {
          return reply.callNotFound();
        }
        return reply.sendFile(file, demoAssetsDir);
      });
      app.log.info(`serving demo example receipts from ${demoAssetsDir}`);
    }

    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        void reply.header('Cache-Control', 'no-cache, must-revalidate');
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.log.warn(`no public dir at ${publicDir} — running API-only (dev mode)`);
  }

  await rescheduleChurner();
  await rescheduleSupermarket();
  await rescheduleModelReview();
  setEmailBaseUrl(await getConfig('app.base_url')); // hosted logo URL for emails
  if (!DEMO_MODE) await rescheduleMailImport();   // no IMAP polling on the demo — see above
  await rescheduleDropfolder();
  if (DEMO_MODE) await rescheduleDemoSweep();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Vorratsdatenspeicher listening on :${PORT}`);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
