import type { FastifyInstance } from 'fastify';
import sql, { DEMO_MODE } from '../db.js';
import { requireOperator } from '../auth/plugin.js';
import { sendMail, smtpConfigured } from '../mailer.js';
import { phoneSetupEmail } from '../email/templates.js';
import { getConfig, setConfig } from '../config.js';
import { setTaskAi, listModelsForProvider, isVisionModel, type AiTask, type ProviderName } from '../llm/provider.js';
import { searxngSearch } from '../llm/searxng.js';

// v1 ships stages A–C; D–G are reserved so the guards accept them once built.
const STAGES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const EVENTS = ['pruefen_visited', 'self_added_list_item'];

// Every configurable AI task (keep in sync with admin.ts VALID_TASKS / provider.ts AiTask). The
// onboarding quickset points ALL of them at one provider so a beginner never picks per-task.
const ALL_AI_TASKS: AiTask[] = ['recategorize', 'churner_stage1', 'churner_stage2', 'ocr', 'categories_chat', 'model_review', 'nlanalytics', 'bankmatch', 'statsask', 'csvmapping', 'mailreinterpret'];
// Sensible defaults so OpenAI/Anthropic need no model choice (both handle text + vision/OCR).
const QUICK_DEFAULTS: Record<string, string> = { anthropic: 'claude-sonnet-5', openai: 'gpt-4o' };

// What WE would run on a self-hosted Ollama, best first. mistral-small3.2 measured ~98% of a
// frontier model's OCR accuracy in our own tests; the rest are lighter fallbacks. Only ever
// suggested when the household actually has the model pulled.
const RECOMMENDED_OCR = ['mistral-small3.2', 'qwen2.5vl', 'minicpm-v', 'llava'];
const RECOMMENDED_TEXT = ['qwen2.5:14b', 'qwen2.5', 'llama3.1', 'mistral'];
// Bounds for the best-effort web lookup — a wizard step must never wait on the open internet.
const WEB_VISION_LOOKUP_MAX = 6;
const WEB_VISION_TIMEOUT_MS = 4000;

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

  /** What the wizard offers a self-hoster running Ollama: the model list of THEIR instance,
   *  which of those can read images, and our recommendation — but only ever a recommendation we
   *  can actually honour, i.e. one that is present on their machine.
   *
   *  Vision capability is decided locally first (isVisionModel knows the common families). Models
   *  it does not recognise get a BEST-EFFORT web lookup via the household's own SearXNG: bounded
   *  in number and time, never fatal, and clearly reported as a guess. A wizard step must not hang
   *  because a search engine is slow. */
  app.get('/api/onboarding/ollama-models', { preHandler: requireOperator }, async (_req, reply) => {
    let names: string[];
    try {
      names = await listModelsForProvider('ollama');
    } catch (e) {
      return reply.code(502).send({ error: 'unreachable', message: (e as Error).message });
    }

    const known = names.map(name => ({ name, vision: isVisionModel('ollama', name), source: 'known' as const }));
    // Only the ones the local rules do NOT already call vision are worth asking the web about,
    // and only a handful of them — this runs while someone waits on a wizard step.
    const unknown = known.filter(m => !m.vision).slice(0, WEB_VISION_LOOKUP_MAX);
    const out = new Map(known.map(m => [m.name, m as { name: string; vision: boolean; source: 'known' | 'web' }]));
    await Promise.all(unknown.map(async m => {
      try {
        const hits = await Promise.race([
          searxngSearch(`ollama ${m.name} vision multimodal image input`),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), WEB_VISION_TIMEOUT_MS)),
        ]);
        const blob = hits.slice(0, 5).map(h => `${h.title} ${h.content ?? ''}`).join(' ').toLowerCase();
        // Require the model's own name nearby, else a generic "vision models" page would vouch
        // for every model we ask about.
        const base = m.name.split(':')[0].toLowerCase();
        if (blob.includes(base) && /(vision|multimodal|image input|bilder)/.test(blob)) {
          out.set(m.name, { name: m.name, vision: true, source: 'web' });
        }
      } catch { /* best effort: leave it classified as text-only */ }
    }));

    const models = names.map(n => out.get(n)!);
    const present = (list: string[]) => list.find(r => names.some(n => n === r || n.startsWith(`${r}:`)));
    return {
      models,
      // null when we cannot recommend anything they actually have — the wizard then leaves the
      // field empty rather than suggesting a download they never made.
      recommended: {
        ocr: present(RECOMMENDED_OCR) ?? null,
        text: present(RECOMMENDED_TEXT) ?? null,
        ocrWanted: RECOMMENDED_OCR[0],
        textWanted: RECOMMENDED_TEXT[0],
      },
    };
  });

  /** Onboarding one-click AI setup: point EVERY task at a single provider so a beginner never
   *  picks per-task models. OpenAI/Anthropic auto-use a good default model (both do text + OCR);
   *  Ollama needs the OCR model + the model for all other tasks. Admin can still mix & match
   *  afterwards. Operator-gated. */
  app.post('/api/onboarding/ai-quickset', { preHandler: requireOperator }, async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string; api_key?: string; url?: string; ocr_model?: string; ki_model?: string };
    const provider = String(body.provider ?? '');
    if (!['anthropic', 'openai', 'ollama'].includes(provider)) return reply.code(400).send({ error: 'invalid_provider' });
    const userId = req.user!.id;

    let ocrModel: string, textModel: string;
    if (provider === 'ollama') {
      const url = (body.url ?? '').trim();
      ocrModel = (body.ocr_model ?? '').trim();
      textModel = (body.ki_model ?? '').trim();
      if (!url) return reply.code(400).send({ error: 'url_required', message: 'Bitte die Ollama-URL angeben.' });
      if (!ocrModel || !textModel) return reply.code(400).send({ error: 'models_required', message: 'Bitte OCR-Modell und KI-Modell angeben.' });
      await setConfig('ollama.url', url, userId);
    } else {
      const key = (body.api_key ?? '').trim();
      if (!key) return reply.code(400).send({ error: 'api_key_required', message: 'Bitte den API-Key angeben.' });
      await setConfig(`${provider}.api_key`, key, userId);
      ocrModel = textModel = QUICK_DEFAULTS[provider];
    }

    for (const task of ALL_AI_TASKS) {
      await setTaskAi(task, provider as ProviderName, task === 'ocr' ? ocrModel : textModel, userId, 'manual');
    }
    return { ok: true, provider };
  });
}
