import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { runChurn, isChurnRunning } from '../churner/index.js';
import { runRecategorize, isRecategorizeRunning, recategorizeOne } from '../maintenance/recategorize.js';
import { getConfig } from '../config.js';

export function maintenanceRoutes(app: FastifyInstance): void {
  app.post('/api/maintenance/churn', { preHandler: requireAdmin }, async (_req, reply) => {
    try {
      const eventId = await runChurn('manual');
      return { ok: true, event_id: eventId };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.post('/api/maintenance/recategorize', { preHandler: requireAdmin }, async (req, reply) => {
    const { only_missing } = (req.body ?? {}) as { only_missing?: boolean };
    try {
      const eventId = await runRecategorize(only_missing ?? false);
      return { ok: true, event_id: eventId };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.get('/api/maintenance/events', { preHandler: requireAdmin }, async (req) => {
    const limit = Math.min(parseInt((req.query as { limit?: string }).limit ?? '100', 10) || 100, 500);
    return sql`
      SELECT id, kind, started_at, ended_at, status, summary
      FROM maintenance_event ORDER BY id DESC LIMIT ${limit}
    `;
  });

  app.get('/api/maintenance/status', { preHandler: requireAdmin }, async () => {
    const lastRuns = await sql`
      SELECT DISTINCT ON (kind) kind, started_at, ended_at, status, summary
      FROM maintenance_event ORDER BY kind, id DESC
    `;
    return {
      churner: {
        enabled: await getConfig('churner.enabled'),
        cron: await getConfig('churner.cron'),
        running: isChurnRunning(),
        last_run: lastRuns.find(r => r.kind === 'churner.run') ?? null,
      },
      recategorize: {
        running: isRecategorizeRunning(),
        last_run: lastRuns.find(r => r.kind === 'recategorize.run') ?? null,
      },
    };
  });

  // Called by n8n (Einkaufszettelpuppe) for each freshly ingested artikel.
  app.post('/api/internal/recategorize-one', async (req, reply) => {
    const { artikel_id } = (req.body ?? {}) as { artikel_id?: number };
    if (!artikel_id) return reply.code(400).send({ error: 'artikel_id required' });
    try {
      const path = await recategorizeOne(artikel_id);
      if (path === null) return reply.code(404).send({ error: 'artikel not found' });
      return { ok: true, category_path: path };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
