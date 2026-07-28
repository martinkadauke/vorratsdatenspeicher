import type { FastifyInstance } from 'fastify';
import sql, { DEMO_MODE } from '../db.js';
import { getConfig } from '../config.js';
import { claimDemoAi, aiLimitMessage } from '../demo/limits.js';
import { sendMail, smtpConfigured } from '../mailer.js';
import { runAnalyticsQuery } from '../analytics/query.js';
import { askAnalytics } from '../analytics/agent.js';
import { buildReport, type ReportInput } from '../analytics/report.js';
import {
  METRICS, DIMENSIONS, GRAINS, SOURCES, AnalyticsError, type AnalyticsQuery, type FilterSpec,
} from '../analytics/catalog.js';

export function analyticsRoutes(app: FastifyInstance): void {
  // Vocabulary for the manual filter UI (and a mirror of what the agent may use).
  app.get('/api/analytics/catalog', async (req) => {
    // Accounts are no longer hidden — list all for the filter UI (private receipts
    // stay hidden in the results via the privacy predicate).
    const konten = await sql`SELECT id, name, is_shared FROM konto ORDER BY sort_order, id`;
    return {
      metrics: Object.values(METRICS).map(m => ({ key: m.key, label: m.label, label_en: m.label_en, unit: m.unit })),
      dimensions: Object.values(DIMENSIONS).map(d => ({ key: d.key, label: d.label, label_en: d.label_en })),
      grains: GRAINS,
      sources: Object.entries(SOURCES).map(([key, v]) => ({ key, label: v.label, label_en: v.label_en })),
      konten: konten.map(k => ({ id: k.id as number, name: k.name as string, is_shared: k.is_shared as boolean })),
    };
  });

  // Execute ONE validated query. Used both by the manual filters and to render
  // each agent-proposed dashboard tile. Read-only by construction (analyticsRead).
  app.post('/api/analytics/query', async (req, reply) => {
    const q = (req.body ?? {}) as AnalyticsQuery;
    try {
      return await runAnalyticsQuery(q, req.user);
    } catch (e) {
      if (e instanceof AnalyticsError) return reply.code(400).send({ error: e.message });
      req.log.error(e);
      return reply.code(500).send({ error: 'analytics query failed' });
    }
  });

  // Natural-language question → validated, read-only dashboard. The LLM only
  // emits a spec of catalog keys; every number is computed by the backend.
  app.post('/api/analytics/ask', async (req, reply) => {
    const body = (req.body ?? {}) as { question?: unknown; lang?: unknown; prior?: { question?: unknown; clarify?: unknown } };
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return reply.code(400).send({ error: 'question required' });
    if (question.length > 1000) return reply.code(400).send({ error: 'question too long' });
    const lang = body.lang === 'en' ? 'en' : 'de';
    const prior = body.prior && typeof body.prior.question === 'string' && typeof body.prior.clarify === 'string'
      ? { question: body.prior.question.slice(0, 1000), clarify: body.prior.clarify.slice(0, 1000) }
      : undefined;
    // Demo only: free-text question → one LLM call, and this route is reachable by any visitor
    // (it is even exempted from the read-only write guard). Charge the shared AI bucket. Claimed
    // AFTER the cheap validation so a malformed request doesn't eat a slot.
    if (DEMO_MODE) {
      const claim = await claimDemoAi(req.user?.household_id);
      if (!claim.ok) return reply.code(429).send({ error: aiLimitMessage(claim.max) });
    }
    try {
      return await askAnalytics(question, req.user, lang, prior);
    } catch (e) {
      req.log.error(e);
      return reply.code(502).send({ error: 'analytics agent unavailable' });
    }
  });

  // Email the current dashboard (for the active filters) to the user as a polished
  // HTML report. Same read-only metrics layer — the report can't see anything the
  // user can't see in the UI.
  app.post('/api/analytics/report', async (req, reply) => {
    const user = req.user;
    if (!user?.email) return reply.code(400).send({ error: 'no_email', message: 'Für dein Konto ist keine E-Mail-Adresse hinterlegt.' });
    if (!(await smtpConfigured())) return reply.code(400).send({ error: 'no_smtp', message: 'SMTP ist nicht konfiguriert (Admin → SMTP).' });
    // Demo only: no LLM here, but it IS a visitor-triggered send on the operator's SMTP relay
    // (whose reputation a loop would burn just as effectively as tokens), so it draws on the
    // same shared bucket. Claimed after the two cheap pre-checks, before anything is sent.
    if (DEMO_MODE) {
      const claim = await claimDemoAi(user.household_id);
      if (!claim.ok) return reply.code(429).send({ error: aiLimitMessage(claim.max) });
    }

    const body = (req.body ?? {}) as {
      filters?: FilterSpec; periodLabel?: string;
      dashboard?: { title?: string; summary?: string; tiles?: Array<{ type?: string; title?: string; rows?: Array<{ bucket?: string; dims?: (string | null)[]; value?: number }>; columns?: { value?: { unit?: string; label?: string } } }> };
    };
    const periodLabel = typeof body.periodLabel === 'string' ? body.periodLabel.slice(0, 80) : '';
    const appUrl = (await getConfig('app.base_url')) || '';

    try {
      let input: ReportInput;
      if (body.dashboard?.tiles?.length) {
        // The NL-generated dashboard the user is looking at.
        input = {
          title: body.dashboard.title || 'Finanzreport',
          summary: body.dashboard.summary,
          periodLabel,
          userName: user.username,
          appUrl,
          tiles: body.dashboard.tiles.slice(0, 10).map(t => ({
            type: typeof t.type === 'string' ? t.type : 'bar',
            title: typeof t.title === 'string' ? t.title : '',
            unit: t.columns?.value?.unit === 'count' ? 'count' : 'eur',
            rows: (Array.isArray(t.rows) ? t.rows : []).slice(0, 50).map(r => ({
              label: String(r.bucket ?? (Array.isArray(r.dims) ? r.dims[0] : null) ?? '—'),
              value: Number(r.value) || 0,
            })),
          })),
        };
      } else {
        // Default dashboard from the active filters.
        const filters = body.filters ?? {};
        const [spend, income, net, cats, months] = await Promise.all([
          runAnalyticsQuery({ metric: 'spend', filters }, user),
          runAnalyticsQuery({ metric: 'income', filters }, user),
          runAnalyticsQuery({ metric: 'net', filters }, user),
          runAnalyticsQuery({ metric: 'spend', dimensions: ['category'], filters, limit: 8 }, user),
          runAnalyticsQuery({ metric: 'spend', grain: 'month', filters, limit: 12 }, user),
        ]);
        input = {
          title: 'Finanzreport', periodLabel, userName: user.username, appUrl,
          tiles: [
            { type: 'kpi', title: 'Ausgaben', unit: 'eur', rows: [{ label: '', value: spend.rows[0]?.value ?? 0 }] },
            { type: 'kpi', title: 'Einnahmen', unit: 'eur', rows: [{ label: '', value: income.rows[0]?.value ?? 0 }] },
            { type: 'kpi', title: 'Saldo', unit: 'eur', rows: [{ label: '', value: net.rows[0]?.value ?? 0 }] },
            { type: 'bar', title: 'Ausgaben pro Monat', unit: 'eur', rows: months.rows.map(r => ({ label: r.bucket ?? '', value: r.value })) },
            { type: 'bar', title: 'Top-Kategorien', unit: 'eur', rows: cats.rows.map(r => ({ label: r.dims[0] ?? '—', value: r.value })) },
          ],
        };
      }
      const { subject, text, html } = buildReport(input);
      await sendMail(user.email, subject, text, html);
      return { sent: true, to: user.email };
    } catch (e) {
      if (e instanceof AnalyticsError) return reply.code(400).send({ error: e.message });
      req.log.error(e);
      return reply.code(502).send({ error: 'send_failed', message: (e as Error).message });
    }
  });
}
