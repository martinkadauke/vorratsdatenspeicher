import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { runAnalyticsQuery } from '../analytics/query.js';
import { askAnalytics } from '../analytics/agent.js';
import {
  METRICS, DIMENSIONS, GRAINS, SOURCES, AnalyticsError, type AnalyticsQuery,
} from '../analytics/catalog.js';

export function analyticsRoutes(app: FastifyInstance): void {
  // Vocabulary for the manual filter UI (and a mirror of what the agent may use).
  app.get('/api/analytics/catalog', async (req) => {
    const konten = req.user?.sees_all_konten
      ? await sql`SELECT id, name, is_shared FROM konto ORDER BY sort_order, id`
      : await sql`SELECT id, name, is_shared FROM konto WHERE is_shared = TRUE OR user_id = ${req.user?.id ?? -1} ORDER BY sort_order, id`;
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
    const body = (req.body ?? {}) as { question?: unknown; lang?: unknown };
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return reply.code(400).send({ error: 'question required' });
    if (question.length > 1000) return reply.code(400).send({ error: 'question too long' });
    const lang = body.lang === 'en' ? 'en' : 'de';
    try {
      return await askAnalytics(question, req.user, lang);
    } catch (e) {
      req.log.error(e);
      return reply.code(502).send({ error: 'analytics agent unavailable' });
    }
  });
}
