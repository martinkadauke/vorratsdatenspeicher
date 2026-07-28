import type { FastifyInstance } from 'fastify';
import sql, { DEMO_MODE, withHousehold } from '../db.js';
import { requireAdmin, requireOperator } from '../auth/plugin.js';
import { runChurn, isChurnRunning, requestChurnStop, runIconFetch } from '../churner/index.js';
import { runRecategorize, isRecategorizeRunning, recategorizeOne } from '../maintenance/recategorize.js';
import { runSeedBaseUnits, isSeedUnitsRunning } from '../maintenance/seedUnits.js';
import { runSupermarketInfo, isSupermarketRunning } from '../supermarket/info.js';
import { getConfig } from '../config.js';
import { claimDemoRecat, recatLimitMessage, claimDemoAi, aiLimitMessage } from '../demo/limits.js';
import { PROGRESS_FRESH_MS, type JobProgress } from '../maintenance/progress.js';

export function maintenanceRoutes(app: FastifyInstance): void {
  app.post('/api/maintenance/churn', { preHandler: requireOperator }, async (_req, reply) => {
    try {
      const eventId = await runChurn('manual');
      return { ok: true, event_id: eventId };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  /** Cooperatively stop the running churn (cross-replica via DB flag). */
  app.post('/api/maintenance/churn/stop', { preHandler: requireOperator }, async () => {
    const stopped = await requestChurnStop();
    return { ok: true, stopping: stopped };
  });

  /** Fetch missing store logos + canonical product images (SearXNG image
   *  search, no LLM). Runs standalone, decoupled from the nightly churn. */
  app.post('/api/maintenance/icons', { preHandler: requireOperator }, async (_req, reply) => {
    try {
      const eventId = await runIconFetch();
      return { ok: true, event_id: eventId };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  app.post('/api/maintenance/recategorize', { preHandler: requireOperator }, async (req, reply) => {
    const { only_missing } = (req.body ?? {}) as { only_missing?: boolean };
    // Demo only: a household gets a handful of recategorisation runs, then it's done — the
    // data is deleted within 24h anyway and each run is a burst of AI calls.
    if (DEMO_MODE) {
      const claim = await claimDemoRecat(req.user?.household_id);
      if (!claim.ok) return reply.code(429).send({ error: recatLimitMessage(claim.max) });
    }
    try {
      const eventId = await runRecategorize(only_missing ?? false);
      return { ok: true, event_id: eventId };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  /** One-time: AI-assign a base_unit (Stück/Packung/kg/l) to every product. */
  app.post('/api/maintenance/seed-base-units', { preHandler: requireAdmin }, async (req, reply) => {
    const { only_missing } = (req.body ?? {}) as { only_missing?: boolean };
    if (isSeedUnitsRunning()) return reply.code(409).send({ error: 'Einheiten-Zuordnung läuft bereits' });
    // Demo only: unlike its siblings this job is behind requireAdmin, which on demo every
    // visitor satisfies for their own household — so it is a visitor-startable AI batch over the
    // whole product list. Charge the shared AI bucket. (The detached job re-opens the caller's
    // household scope itself — see runSeedBaseUnits — so it really does run; the cap is the only
    // thing bounding it, not RLS starvation.)
    if (DEMO_MODE) {
      const claim = await claimDemoAi(req.user?.household_id);
      if (!claim.ok) return reply.code(429).send({ error: aiLimitMessage(claim.max) });
    }
    try {
      const eventId = await runSeedBaseUnits(only_missing ?? false);
      return { ok: true, event_id: eventId };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message });
    }
  });

  /** Fetch supermarket info for all branches now: opening hours via OSM AND — at the end of the
   *  same job — a full offer search plus the digest mails (supermarket/info.ts). The name only
   *  describes the first half. */
  app.post('/api/maintenance/supermarket-info', { preHandler: requireAdmin }, async (_req, reply) => {
    if (isSupermarketRunning()) return reply.code(409).send({ error: 'Supermarkt-Infos laufen bereits' });
    // Demo only: requireAdmin is satisfied by every visitor for their own household, and this job
    // is NOT "OSM opening hours only" — runSupermarketInfo() ends with `runOfferSearch()` +
    // `sendOfferDigests()`, i.e. exactly the per-product LLM burst and the digest mail that
    // /api/offers/refresh is charged for. Uncapped it is a one-request bypass of that cap with a
    // different button. The burst used to be mostly inert because the detached job carried no
    // household scope and RLS handed it an empty subscription list — an accident, not a control
    // (same reasoning as seed-base-units above). That accident is gone as of the withHousehold
    // scoping below, which is exactly why this charge has to stand on the shape of the code
    // rather than on yesterday's luck.
    if (DEMO_MODE) {
      const claim = await claimDemoAi(_req.user?.household_id);
      if (!claim.ok) return reply.code(429).send({ error: aiLimitMessage(claim.max) });
    }
    // Run in background; the event log + button state reflect progress. On demo the detached job
    // must hold its OWN household-scoped connection, exactly like /api/offers/refresh: this
    // handler's reserved connection is released the moment the response is sent, and the crawler
    // then works on household-scoped tables with id-only predicates that ONLY RLS filters —
    // `SELECT id, name FROM store_branch WHERE kind='filiale'` and two
    // `UPDATE store_branch … WHERE id = $1`. Unscoped that means either nothing at all (RLS →
    // zero rows, so the button reports "fertig, 0 geprüft" forever with no explanation) or, if
    // the pool has meanwhile handed that physical connection to another household's request,
    // those id-only UPDATEs land in a stranger's scope. The cap above is charged either way
    // (see there), so scoping it costs the demo nothing extra. Off-demo this branch never runs.
    if (DEMO_MODE) {
      const hid = _req.user!.household_id ?? 1;
      void withHousehold(hid, () => runSupermarketInfo()).catch(err => _req.log.error(`supermarket-info failed: ${err.message}`));
    } else {
      void runSupermarketInfo().catch(err => _req.log.error(`supermarket-info failed: ${err.message}`));
    }
    return { ok: true, started: true };
  });

  app.get('/api/maintenance/events', { preHandler: requireOperator }, async (req) => {
    const limit = Math.min(parseInt((req.query as { limit?: string }).limit ?? '100', 10) || 100, 500);
    return sql`
      SELECT id, kind, started_at, ended_at, status, summary
      FROM maintenance_event ORDER BY id DESC LIMIT ${limit}
    `;
  });

  app.get('/api/maintenance/status', { preHandler: requireOperator }, async () => {
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
