import './env.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import './types.js';
import sql, { migrate, ensureAdmin } from './db.js';
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
import { rescheduleChurner } from './churner/scheduler.js';

async function main(): Promise<void> {
  await migrate();
  await ensureAdmin();

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

  // Static SPA + receipt images
  const publicDir = path.join(process.cwd(), 'public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.log.warn(`no public dir at ${publicDir} — running API-only (dev mode)`);
  }

  await rescheduleChurner();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Vorratsdatenspeicher listening on :${PORT}`);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
