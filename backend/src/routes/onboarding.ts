import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

// v1 ships stages A–C; D–G are reserved so the guards accept them once built.
const STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const EVENTS = ['pruefen_visited', 'self_added_list_item'];

/** Progressive onboarding coach (FB-01). Per-user progress (which stages the user
 *  dismissed, which client-observed events happened) + the server-computed milestones
 *  the driver needs to decide which stage to show. Off-demo only in the UI; the routes
 *  are user-scoped and harmless everywhere. No preHandler — auth is the global hook. */
export function onboardingRoutes(app: FastifyInstance): void {
  app.get('/api/onboarding/coach', async (req) => {
    const userId = req.user!.id;
    const [row] = await sql`SELECT dismissed, events FROM user_onboarding WHERE user_id = ${userId}`;
    // Milestones are HOUSEHOLD-wide (any user's scanned receipt counts) — off-demo there is
    // one household, so no scoping needed; the coach never runs on the demo.
    const [rc] = await sql`SELECT COUNT(*)::int AS n FROM einkauf WHERE bild_pfad IS NOT NULL AND bild_pfad <> ''`;
    const [ac] = await sql`SELECT EXISTS(SELECT 1 FROM artikel WHERE user_corrected) AS is_set`;
    return {
      dismissed: (row?.dismissed as string[] | undefined) ?? [],
      events: (row?.events as Record<string, boolean> | undefined) ?? {},
      milestones: {
        receipts: rc?.n ?? 0,
        artikelname_set: !!ac?.is_set,
      },
    };
  });

  /** Permanently dismiss a stage ("nicht mehr anzeigen"). Idempotent — the stage is added
   *  to the set only if absent. */
  app.post('/api/onboarding/coach/dismiss', async (req, reply) => {
    const stage = String((req.body as { stage?: string })?.stage ?? '');
    if (!STAGES.includes(stage)) return reply.code(400).send({ error: 'unknown stage' });
    await sql`
      INSERT INTO user_onboarding (user_id, dismissed, updated_at)
      VALUES (${req.user!.id}, ARRAY[${stage}]::text[], NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET dismissed = ARRAY(SELECT DISTINCT unnest(user_onboarding.dismissed || EXCLUDED.dismissed)),
            updated_at = NOW()`;
    return { ok: true };
  });

  /** Record a client-observed milestone event (e.g. the user opened Prüfen). Idempotent. */
  app.post('/api/onboarding/coach/event', async (req, reply) => {
    const event = String((req.body as { event?: string })?.event ?? '');
    if (!EVENTS.includes(event)) return reply.code(400).send({ error: 'unknown event' });
    await sql`
      INSERT INTO user_onboarding (user_id, events, updated_at)
      VALUES (${req.user!.id}, jsonb_build_object(${event}::text, true), NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET events = user_onboarding.events || jsonb_build_object(${event}::text, true),
            updated_at = NOW()`;
    return { ok: true };
  });

  /** Restart onboarding: wipe dismissals + events so every stage can trigger again. */
  app.post('/api/onboarding/coach/reset', async (req) => {
    await sql`
      INSERT INTO user_onboarding (user_id, dismissed, events, updated_at)
      VALUES (${req.user!.id}, '{}', '{}'::jsonb, NOW())
      ON CONFLICT (user_id) DO UPDATE SET dismissed = '{}', events = '{}'::jsonb, updated_at = NOW()`;
    return { ok: true };
  });
}
