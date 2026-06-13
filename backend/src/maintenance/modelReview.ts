// Bi-weekly AI model review. For EVERY AI task the reviewer LLM (itself a
// configurable task → can run pure-local) proposes the best API/cloud model AND
// the best open-weight (Ollama) model, weighing price/performance. The
// super-admin then accepts all-API or all-open-weight (or rejects) via tokenized
// email links. Nothing is switched automatically.
import crypto from 'node:crypto';
import cron from 'node-cron';
import sql from '../db.js';
import { getConfig } from '../config.js';
import {
  providerForTask, listModelsForProvider, setTaskAi, type AiTask, type ProviderName,
} from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';
import { sendMail } from '../mailer.js';
import { modelReviewEmail } from '../email/templates.js';

let running = false;
export function isModelReviewRunning(): boolean { return running; }

const REVIEW_TASKS: AiTask[] = ['recategorize', 'churner_stage1', 'churner_stage2', 'ocr', 'categories_chat'];
const CLOUD_PROVIDERS: ProviderName[] = ['anthropic', 'deepseek'];

export interface Candidate { provider: string; model: string; reason: string }
export interface Proposal {
  task: string; current_provider: string; current_model: string;
  api: Candidate | null; open: Candidate | null;
}

const TASK_PURPOSE: Record<string, string> = {
  recategorize: 'Klassifiziert Artikel in eine Kategorie-Hierarchie (einfache Text-Klassifikation, JSON).',
  churner_stage1: 'Normalisiert OCR-Artikelnamen zu kanonischen Produktnamen (einfache Text-Aufgabe, JSON).',
  churner_stage2: 'Ordnet kanonische Produkte einer Kategorie zu (einfache Klassifikation, JSON).',
  ocr: 'Vision-OCR von Kassenbon-Fotos zu strukturiertem JSON (braucht ein VISION-fähiges Modell, anspruchsvoll).',
  categories_chat: 'Chat-Assistent zum Bearbeiten der Kategorie-Hierarchie (etwas Reasoning).',
};

/** Coarse cost tier so even a small local reviewer model judges price/performance. */
function tier(model: string): string {
  if (/opus|fable/i.test(model)) return 'Flaggschiff, SEHR TEUER';
  if (/sonnet/i.test(model)) return 'ausgewogen, mittlerer Preis';
  if (/haiku/i.test(model)) return 'klein & günstig';
  if (/reasoner|r1/i.test(model)) return 'günstig (Reasoning)';
  if (/deepseek/i.test(model)) return 'sehr günstig';
  return 'open-weight, lokal/kostenlos';
}

export async function runModelReview(): Promise<number | null> {
  if (running) throw new Error('Model-Review läuft bereits');
  running = true;
  try {
    // candidate pools (fetched once; same across tasks)
    const apiModels: { provider: string; model: string }[] = [];
    for (const p of CLOUD_PROVIDERS) {
      try { (await listModelsForProvider(p)).forEach(m => apiModels.push({ provider: p, model: m })); } catch { /* not configured/reachable */ }
    }
    let openModels: string[] = [];
    try { openModels = await listModelsForProvider('ollama'); } catch { /* ollama unreachable */ }

    const apiList = apiModels.map(m => `${m.model} [${m.provider}, ${tier(m.model)}]`).join(', ') || '(keine)';
    const openList = openModels.map(m => `${m} [${tier(m)}]`).join(', ') || '(keine)';

    const reviewer = await providerForTask('model_review');
    const proposals: Proposal[] = [];
    let actionable = false;

    for (const task of REVIEW_TASKS) {
      const provider = (await getConfig(`ai.${task}.provider` as 'ai.recategorize.provider')) as ProviderName;
      const current = await getConfig(`ai.${task}.model` as 'ai.recategorize.model');

      const system =
        'Du bist Experte für LLM-Modellwahl mit klarem Fokus auf PREIS/LEISTUNG. Für die gegebene Aufgabe wählst du '
        + 'JE das beste API/Cloud-Modell UND das beste Open-Weight-Modell (lokal via Ollama). Regeln: '
        + '(1) Wähle das GÜNSTIGSTE Modell, das die Aufgabe zuverlässig erfüllt. '
        + '(2) Teure Flaggschiff-Modelle NUR, wenn die Aufgabe es wirklich erfordert (komplexes Reasoning oder anspruchsvolle Vision) — '
        + 'für einfache Klassifikation/Normalisierung sind sie Verschwendung. '
        + '(3) Vision-Aufgaben (OCR) brauchen ein vision-fähiges Modell. '
        + '(4) Verwende NUR Modell-IDs aus den gegebenen Listen. '
        + 'Antworte AUSSCHLIESSLICH mit JSON: '
        + '{"api": {"provider": "anthropic|deepseek", "model": "id", "reason": "kurz, inkl. Preis/Leistung"} | null, '
        + '"open": {"model": "ollama-id", "reason": "kurz"} | null}. '
        + 'Wenn eine Liste leer ist, setze das jeweilige Feld auf null.';
      const user =
        `Aufgabe: ${TASK_PURPOSE[task] ?? task}\nAktuell: ${current} (${provider})\n`
        + `API/Cloud-Modelle: ${apiList}\nOpen-Weight-Modelle (Ollama): ${openList}\n\n`
        + `Wähle je das beste – preis/leistungs-optimal, nicht einfach das teuerste.`;

      let api: Candidate | null = null;
      let open: Candidate | null = null;
      try {
        const raw = await reviewer.chat({ system, user, json: true });
        const res = parseLlmJson<{
          api?: { provider?: string; model?: string; reason?: string } | null;
          open?: { model?: string; reason?: string } | null;
        }>(raw);
        if (res.api?.model && apiModels.some(m => m.model === res.api!.model)) {
          const prov = apiModels.find(m => m.model === res.api!.model)!.provider;
          api = { provider: prov, model: res.api.model, reason: (res.api.reason ?? '').toString().slice(0, 240) };
        }
        if (res.open?.model && openModels.includes(res.open.model)) {
          open = { provider: 'ollama', model: res.open.model, reason: (res.open.reason ?? '').toString().slice(0, 240) };
        }
      } catch { /* skip on LLM/parse error */ }

      if (!api && !open) continue;
      proposals.push({ task, current_provider: provider, current_model: current, api, open });
      if ((api && (api.provider !== provider || api.model !== current))
        || (open && (provider !== 'ollama' || open.model !== current))) actionable = true;
    }

    if (!proposals.length || !actionable) { console.log('[model-review] nothing actionable'); return null; }

    const token = crypto.randomBytes(24).toString('hex');
    const [row] = await sql`
      INSERT INTO model_review (proposals, token) VALUES (${sql.json(proposals as never)}, ${token}) RETURNING id
    `;
    const id = row.id as number;
    await emailReview(id, token, proposals);
    return id;
  } finally {
    running = false;
  }
}

async function emailReview(id: number, token: string, proposals: Proposal[]): Promise<void> {
  const supers = await sql`SELECT email FROM users WHERE sees_all_konten = TRUE AND email IS NOT NULL AND email <> ''`;
  if (!supers.length) { console.warn('[model-review] no super-admin email configured'); return; }
  const base = (await getConfig('app.base_url')).replace(/\/$/, '');
  const link = (action: string) => `${base}/api/model-review/${id}/decide?token=${token}&action=${action}`;
  const mail = modelReviewEmail({
    proposals,
    links: { apply_api: link('apply_api'), apply_open: link('apply_open'), reject: link('reject') },
  });
  for (const s of supers) {
    try { await sendMail(s.email as string, mail.subject, mail.text, mail.html); }
    catch (e) { console.error('[model-review] email failed:', (e as Error).message); }
  }
}

export type ReviewAction = 'apply_api' | 'apply_open' | 'reject';

/** Apply (all-API or all-open) or reject a pending review (token-checked). */
export async function decideModelReview(
  id: number, token: string, action: ReviewAction,
): Promise<{ ok: boolean; status?: string; applied?: number; error?: string }> {
  const [row] = await sql`SELECT status, proposals, token FROM model_review WHERE id = ${id}`;
  if (!row) return { ok: false, error: 'not found' };
  if (row.token !== token) return { ok: false, error: 'invalid token' };
  if (row.status !== 'pending') return { ok: false, error: 'already decided', status: row.status as string };

  const proposals = row.proposals as Proposal[];
  let applied = 0;
  let status: string;
  if (action === 'apply_api') {
    for (const p of proposals) if (p.api) { await setTaskAi(p.task as AiTask, p.api.provider as ProviderName, p.api.model, undefined, 'auto_review'); applied++; }
    status = 'applied_api';
  } else if (action === 'apply_open') {
    for (const p of proposals) if (p.open) { await setTaskAi(p.task as AiTask, 'ollama', p.open.model, undefined, 'auto_review'); applied++; }
    status = 'applied_open';
  } else {
    status = 'rejected';
  }
  await sql`UPDATE model_review SET status = ${status}, decided_at = NOW() WHERE id = ${id}`;
  return { ok: true, status, applied };
}

// ── scheduler ───────────────────────────────────────────────────────────────
let task: cron.ScheduledTask | null = null;

export async function rescheduleModelReview(): Promise<void> {
  if (task) { task.stop(); task = null; }
  const enabled = await getConfig('model_review.enabled');
  const schedule = await getConfig('model_review.cron');
  if (!enabled) { console.log('[model-review] disabled'); return; }
  if (!cron.validate(schedule)) { console.error(`[model-review] invalid cron "${schedule}"`); return; }
  task = cron.schedule(schedule, () => {
    if (isModelReviewRunning()) return;
    runModelReview().catch(err => console.error('[model-review] cron run failed:', err));
  });
  console.log(`[model-review] scheduled: ${schedule}`);
}
