import type { FastifyInstance } from 'fastify';
import sql, { DEMO_MODE } from '../db.js';
import { sendMail, smtpConfigured } from '../mailer.js';
import { phoneSetupEmail } from '../email/templates.js';
import { getConfig } from '../config.js';

// v1 ships stages A–C; D–G are reserved so the guards accept them once built.
const STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const EVENTS = ['pruefen_visited', 'self_added_list_item'];

// Defense-in-depth for the self-addressed setup-guide mail: even though it can only reach
// the caller's own verified address, a runaway client/insider shouldn't drain the household's
// shared SMTP quota (which invite/reset mail depends on). In-memory, per-user, generous cap.
const guideSends = new Map<number, number[]>();
const GUIDE_MAX_PER_HOUR = 6;
function guideRateLimited(userId: number): boolean {
  const now = Date.now();
  const recent = (guideSends.get(userId) ?? []).filter(t => now - t < 3_600_000);
  guideSends.set(userId, recent);
  if (recent.length >= GUIDE_MAX_PER_HOUR) return true;
  recent.push(now);
  return false;
}

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

  /** Stage B "mir als E-Mail senden": email the signed-in user the phone-setup guide
   *  (PWA install + how to make the instance reachable). Off-demo; needs an address + SMTP. */
  app.post('/api/onboarding/coach/mail-setup-guide', async (req, reply) => {
    if (DEMO_MODE) return reply.code(403).send({ error: 'forbidden' });
    const user = req.user;
    if (!user?.email) return reply.code(400).send({ error: 'no_email', message: 'Für dein Konto ist keine E-Mail-Adresse hinterlegt.' });
    if (!(await smtpConfigured())) return reply.code(400).send({ error: 'no_smtp', message: 'Auf dieser Instanz ist kein E-Mail-Versand eingerichtet (Admin → SMTP).' });
    if (guideRateLimited(user.id)) return reply.code(429).send({ error: 'rate_limited', message: 'Zu viele Anfragen — bitte später erneut.' });
    const appUrl = (await getConfig('app.base_url')) || '';
    const { subject, text, html } = phoneSetupEmail({ appUrl });
    try {
      await sendMail(user.email, subject, text, html);
    } catch (e) {
      req.log.warn(`coach setup-guide mail failed: ${(e as Error).message}`);
      return reply.code(502).send({ error: 'mail_failed', message: 'E-Mail konnte nicht gesendet werden.' });
    }
    return { sent: true, to: user.email };
  });
}
