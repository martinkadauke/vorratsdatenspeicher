import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

export function i18nRoutes(app: FastifyInstance): void {
  app.get('/api/i18n/canonicals', async (req) => {
    const lang = (req.query as { lang?: string }).lang ?? 'en';
    const rows = await sql`
      SELECT canonical_name, translated FROM canonical_translation WHERE lang = ${lang}
    `;
    const map: Record<string, string> = {};
    for (const r of rows) map[r.canonical_name as string] = r.translated as string;
    return map;
  });
}
