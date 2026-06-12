import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { runChurn, isChurnRunning, requestChurnStop } from '../churner/index.js';
import { runRecategorize, isRecategorizeRunning, recategorizeOne } from '../maintenance/recategorize.js';
import { getConfig } from '../config.js';
import { PROGRESS_FRESH_MS, type JobProgress } from '../maintenance/progress.js';

export function maintenanceRoutes(app: FastifyInstance): void {
  app.post('/api/maintenance/churn', { preHandler: requireAdmin }, async (_req, reply) => {
    try {
      const eventId = await runChurn('manual');
      return { ok: true, event_id: eventId };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  /** Cooperatively stop the running churn (cross-replica via DB flag). */
  app.post('/api/maintenance/churn/stop', { preHandler: requireAdmin }, async () => {
    const stopped = await requestChurnStop();
    return { ok: true, stopping: stopped };
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
    const now = Date.now();
    const staleBefore = now - PROGRESS_FRESH_MS;

    // Opportunistic orphan sweep: events left 'running' by a container that
    // died mid-job (e.g. a rolling deploy) — started long ago and with no
    // fresh progress heartbeat. Self-healing so the log doesn't accumulate
    // ghosts. Cheap (matches nothing once swept). Best-effort.
    try {
      await sql`
        UPDATE maintenance_event SET status = 'interrupted', ended_at = NOW()
        WHERE status = 'running'
          AND started_at < NOW() - INTERVAL '10 minutes'
          AND (progress IS NULL OR COALESCE((progress->>'ts')::bigint, 0) < ${staleBefore})
      `;
    } catch { /* non-fatal */ }

    // Latest event per kind (includes a possibly-running one with live progress).
    const lastRuns = await sql`
      SELECT DISTINCT ON (kind) kind, started_at, ended_at, status, summary, progress
      FROM maintenance_event ORDER BY kind, id DESC
    `;

    // A job is "live" cross-replica if its latest event is still 'running'
    // and its progress heartbeat is fresh — independent of which replica
    // (and its in-memory flag) the status request happened to hit.
    const liveProgress = (ev: { status?: string; progress?: JobProgress | null } | undefined): JobProgress | null => {
      if (!ev || ev.status !== 'running' || !ev.progress) return null;
      const ts = ev.progress.ts ?? 0;
      return ts >= staleBefore ? ev.progress : null;
    };

    const latestChurn = lastRuns.find(r => r.kind === 'churner.run') as { status?: string; progress?: JobProgress | null } | undefined;
    const latestRecat = lastRuns.find(r => r.kind === 'recategorize.run') as { status?: string; progress?: JobProgress | null } | undefined;
    const churnProgress = liveProgress(latestChurn);
    const recatProgress = liveProgress(latestRecat);

    // last_run = most recent COMPLETED run (not the in-flight one).
    const lastCompleted = await sql`
      SELECT DISTINCT ON (kind) kind, started_at, ended_at, status, summary
      FROM maintenance_event WHERE status != 'running'
      ORDER BY kind, id DESC
    `;

    return {
      churner: {
        enabled: await getConfig('churner.enabled'),
        cron: await getConfig('churner.cron'),
        running: isChurnRunning() || churnProgress !== null,
        progress: churnProgress,
        last_run: lastCompleted.find(r => r.kind === 'churner.run') ?? null,
      },
      recategorize: {
        running: isRecategorizeRunning() || recatProgress !== null,
        progress: recatProgress,
        last_run: lastCompleted.find(r => r.kind === 'recategorize.run') ?? null,
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
