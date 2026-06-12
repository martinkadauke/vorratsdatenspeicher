// Bi-weekly AI model review. The reviewer LLM (itself a configurable AI task —
// so the whole thing can run on a pure-local model) checks, per AI task,
// whether a clearly better/newer model is available, and emails the super-admin
// a yes/no proposal. Nothing is switched automatically.
import crypto from 'node:crypto';
import cron from 'node-cron';
import sql from '../db.js';
import { getConfig } from '../config.js';
import {
  providerForTask, listModelsForProvider, setTaskAi, type AiTask, type ProviderName,
} from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';
import { sendMail } from '../mailer.js';

let running = false;
export function isModelReviewRunning(): boolean { return running; }

const REVIEW_TASKS: AiTask[] = ['recategorize', 'churner_stage1', 'churner_stage2', 'ocr', 'categories_chat'];

export interface Proposal {
  task: string; provider: string; current_model: string; suggested_model: string; reason: string;
}

const TASK_PURPOSE: Record<string, string> = {
  recategorize: 'Klassifiziert Artikel in eine Kategorie-Hierarchie (Text, JSON-Ausgabe).',
  churner_stage1: 'Normalisiert OCR-Artikelnamen zu kanonischen Produktnamen (Text, JSON).',
  churner_stage2: 'Ordnet kanonische Produkte einer Kategorie zu (Text, JSON).',
  ocr: 'Vision-OCR von Kassenbon-Fotos zu strukturiertem JSON (braucht Vision-Fähigkeit).',
  categories_chat: 'Chat-Assistent zum Bearbeiten der Kategorie-Hierarchie (Reasoning).',
};

/** Build proposals + email the super-admin. Returns the review id (or null when
 *  there's nothing to suggest). */
export async function runModelReview(): Promise<number | null> {
  if (running) throw new Error('Model-Review läuft bereits');
  running = true;
  try {
    const reviewer = await providerForTask('model_review');
    const proposals: Proposal[] = [];

    for (const task of REVIEW_TASKS) {
      const provider = (await getConfig(`ai.${task}.provider` as 'ai.recategorize.provider')) as ProviderName;
      const current = await getConfig(`ai.${task}.model` as 'ai.recategorize.model');
      let available: string[] = [];
      try { available = await listModelsForProvider(provider); } catch { continue; } // provider unreachable
      if (!available.length) continue;

      const system =
        'Du bewertest die LLM-Modellwahl für eine Aufgabe. Antworte AUSSCHLIESSLICH mit JSON: '
        + '{"better": boolean, "suggested": "model-id aus der Liste", "reason": "kurz"}. '
        + 'Empfiehl nur ein Modell aus der gegebenen Liste und nur, wenn es für die Aufgabe klar besser/neuer ist '
        + 'als das aktuelle. Bei Vision-Aufgaben nur Vision-fähige Modelle. Im Zweifel oder wenn das aktuelle gut ist: better=false.';
      const user =
        `Aufgabe: ${TASK_PURPOSE[task] ?? task}\nProvider: ${provider}\nAktuelles Modell: ${current}\n`
        + `Verfügbare Modelle: ${available.join(', ')}\n\nGibt es ein klar besseres Modell aus der Liste?`;

      try {
        const raw = await reviewer.chat({ system, user, json: true });
        const res = parseLlmJson<{ better?: boolean; suggested?: string; reason?: string }>(raw);
        if (res.better && res.suggested && res.suggested !== current && available.includes(res.suggested)) {
          proposals.push({
            task, provider, current_model: current, suggested_model: res.suggested,
            reason: (res.reason ?? '').toString().slice(0, 300),
          });
        }
      } catch { /* skip this task on LLM/parse error */ }
    }

    if (!proposals.length) { console.log('[model-review] no proposals'); return null; }

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
  const applyUrl = `${base}/api/model-review/${id}/decide?token=${token}&action=apply`;
  const rejectUrl = `${base}/api/model-review/${id}/decide?token=${token}&action=reject`;
  const lines = proposals.map(p => `• ${p.task}: ${p.current_model}  →  ${p.suggested_model}\n    ${p.reason}`).join('\n');
  const body =
    `Der KI-Modell-Review schlägt folgende Änderungen vor:\n\n${lines}\n\n`
    + `ALLE übernehmen:\n${applyUrl}\n\n`
    + `ALLE ablehnen:\n${rejectUrl}\n\n`
    + `Du kannst die Modelle auch jederzeit manuell in Admin → KI-Aufgaben ändern.`;
  for (const s of supers) {
    try { await sendMail(s.email as string, 'VDS: KI-Modell-Review – Vorschläge', body); }
    catch (e) { console.error('[model-review] email failed:', (e as Error).message); }
  }
}

/** Apply or reject a pending review (token-checked). Used by both the email
 *  links and the in-app admin buttons (latter passes the row's token). */
export async function decideModelReview(
  id: number, token: string, action: 'apply' | 'reject',
): Promise<{ ok: boolean; status?: string; applied?: Proposal[]; error?: string }> {
  const [row] = await sql`SELECT status, proposals, token FROM model_review WHERE id = ${id}`;
  if (!row) return { ok: false, error: 'not found' };
  if (row.token !== token) return { ok: false, error: 'invalid token' };
  if (row.status !== 'pending') return { ok: false, error: 'already decided', status: row.status as string };

  const proposals = row.proposals as Proposal[];
  if (action === 'apply') {
    for (const p of proposals) {
      await setTaskAi(p.task as AiTask, p.provider as ProviderName, p.suggested_model, undefined, 'auto_review');
    }
    await sql`UPDATE model_review SET status = 'applied', decided_at = NOW() WHERE id = ${id}`;
    return { ok: true, status: 'applied', applied: proposals };
  }
  await sql`UPDATE model_review SET status = 'rejected', decided_at = NOW() WHERE id = ${id}`;
  return { ok: true, status: 'rejected' };
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
