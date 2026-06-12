import './env.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import './types.js';
import sql, { migrate, ensureAdmin } from './db.js';
import { initSearch } from './lib/search.js';
import { PORT } from './config.js';
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
import { queueRoutes } from './routes/queue.js';
import { notificationRoutes } from './routes/notifications.js';
import { adminRoutes } from './routes/admin.js';
import { meRoutes } from './routes/me.js';
import { maintenanceRoutes } from './routes/maintenance.js';
import { i18nRoutes } from './routes/i18n.js';
import { exportRoutes } from './routes/exports.js';
import { storeRoutes } from './routes/stores.js';
import { trendsRoutes } from './routes/trends.js';
import { iconRoutes } from './routes/icons.js';
import { kontoRoutes } from './routes/konten.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { rescheduleChurner } from './churner/scheduler.js';
import { rescheduleSupermarket } from './supermarket/scheduler.js';

async function main(): Promise<void> {
  await migrate();
  await ensureAdmin();
  await initSearch();

  // Sweep any maintenance events left "running" by a previous container that
  // died mid-loop. Without this they'd block new runs forever (running flag
  // resets on restart but the row stays unfinished).
  await sql`
    UPDATE maintenance_event
    SET status = 'interrupted', ended_at = NOW(),
        summary = COALESCE(summary, '{}'::jsonb) || ${sql.json({ interrupted_by: 'container_restart' })}
    WHERE status = 'running'
  `;

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
  notificationRoutes(app);
  adminRoutes(app);
  meRoutes(app);
  maintenanceRoutes(app);
  i18nRoutes(app);
  exportRoutes(app);
  storeRoutes(app);
  trendsRoutes(app);
  iconRoutes(app);
  kontoRoutes(app);
  subscriptionRoutes(app);

  // Receipt photos under /receipts/* — served directly by the app so a
  // single-container install (Unraid CA, docker-compose) doesn't need a
  // reverse-proxy mount. In our multi-host setup NPM intercepts first
  // and never reaches the backend, so this is purely additive.
  const receiptsDir = process.env.RECEIPTS_LOCAL_PATH ?? '/receipts';
  if (existsSync(receiptsDir)) {
    await app.register(fastifyStatic, {
      root: receiptsDir,
      prefix: '/receipts/',
      decorateReply: false,
      wildcard: false,
    });
    app.log.info(`serving receipt photos from ${receiptsDir}`);
  } else {
    app.log.warn(`no receipts dir at ${receiptsDir} — rotation + static serving disabled`);
  }

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

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Vorratsdatenspeicher listening on :${PORT}`);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
