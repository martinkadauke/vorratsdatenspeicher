import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { runModelReview, decideModelReview, isModelReviewRunning, type ReviewAction } from '../maintenance/modelReview.js';

const ACTIONS: ReviewAction[] = ['apply_api', 'apply_open', 'reject'];

export function modelReviewRoutes(app: FastifyInstance): void {
  /** Latest review (for the admin display). */
  app.get('/api/model-review/latest', { preHandler: requireAdmin }, async () => {
    const [row] = await sql`
      SELECT id, created_at, status, proposals, token, decided_at
      FROM model_review ORDER BY id DESC LIMIT 1
    `;
    return row ?? null;
  });

  /** Run the review now (manual/testing). */
  app.post('/api/model-review/run', { preHandler: requireAdmin }, async (_req, reply) => {
    if (isModelReviewRunning()) return reply.code(409).send({ error: 'review already running' });
    try {
      const id = await runModelReview();
      return { ok: true, id, proposals: id !== null };
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /** In-app apply/reject from the admin UI (admin-authed; uses the row token). */
  app.post('/api/model-review/:id/decide', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { action } = (req.body ?? {}) as { action?: ReviewAction };
    if (!id || !action || !ACTIONS.includes(action)) return reply.code(400).send({ error: 'id + valid action required' });
    const [row] = await sql`SELECT token FROM model_review WHERE id = ${id}`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const result = await decideModelReview(id, row.token as string, action);
    if (!result.ok) return reply.code(409).send(result);
    return result;
  });

  /** Public, tokenized apply/reject from the email links. Returns a small HTML
   *  page so clicking from a mail client gives readable feedback. */
  app.get('/api/model-review/:id/decide', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const { token, action } = req.query as { token?: string; action?: string };
    const page = (title: string, msg: string) =>
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#18181b}`
      + `.box{border:1px solid #e4e4e7;border-radius:1rem;padding:1.5rem}h1{font-size:1.25rem}</style></head>`
      + `<body><div class="box"><h1>${title}</h1><p>${msg}</p></div></body></html>`;

    if (!id || !token || !action || !ACTIONS.includes(action as ReviewAction)) {
      return reply.code(400).type('text/html').send(page('Ungültiger Link', 'Der Link ist unvollständig.'));
    }
    const result = await decideModelReview(id, token, action as ReviewAction);
    if (!result.ok) {
      const msg = result.error === 'already decided'
        ? `Dieser Review wurde bereits bearbeitet (Status: ${result.status}).`
        : 'Der Link ist ungültig oder abgelaufen.';
      return reply.code(result.error === 'already decided' ? 200 : 403).type('text/html').send(page('Bereits bearbeitet', msg));
    }
    const applied = result.status !== 'rejected';
    const kind = result.status === 'applied_api' ? 'API-Modelle' : result.status === 'applied_open' ? 'Open-Weight-Modelle' : '';
    const msg = applied
      ? `Alle ${kind} wurden übernommen (${result.applied ?? 0} Aufgaben). Du kannst sie jederzeit in Admin → KI-Aufgaben anpassen.`
      : 'Die Vorschläge wurden abgelehnt. Es wurde nichts geändert.';
    return reply.type('text/html').send(page(applied ? 'Übernommen ✓' : 'Abgelehnt', msg));
  });
}
