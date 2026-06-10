import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

export function nameRoutes(app: FastifyInstance): void {
  app.get('/api/names', async (req) => {
    const q = (req.query as { q?: string }).q?.trim();
    const like = `%${q ?? ''}%`;
    const rows = await sql`
      SELECT a.canonical_name,
             COUNT(*)::int AS artikel_count,
             mode() WITHIN GROUP (ORDER BY a.category_path) AS category_path,
             MAX(e.datum)::text AS last_bought
      FROM artikel a
      LEFT JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.canonical_name IS NOT NULL
        ${q ? sql`AND a.canonical_name ILIKE ${like}` : sql``}
      GROUP BY a.canonical_name
      ORDER BY a.canonical_name ASC
    `;

    const names = rows.map(r => r.canonical_name as string);
    const translations = names.length ? await sql`
      SELECT canonical_name, translated FROM canonical_translation
      WHERE lang = 'en' AND canonical_name IN ${sql(names)}
    ` : [];
    const consumers = names.length ? await sql`
      SELECT canonical_name, family_member_id, is_exclusive FROM canonical_consumer
      WHERE canonical_name IN ${sql(names)}
    ` : [];

    const trMap = new Map(translations.map(t => [t.canonical_name as string, t.translated as string]));
    const coMap = new Map<string, { members: number[]; exclusive: boolean }>();
    for (const c of consumers) {
      const entry = coMap.get(c.canonical_name) ?? { members: [], exclusive: false };
      entry.members.push(c.family_member_id);
      entry.exclusive = entry.exclusive || c.is_exclusive;
      coMap.set(c.canonical_name, entry);
    }

    return rows.map(r => ({
      ...r,
      translation_en: trMap.get(r.canonical_name as string) ?? null,
      consumers: coMap.get(r.canonical_name as string)?.members ?? [],
      consumers_exclusive: coMap.get(r.canonical_name as string)?.exclusive ?? false,
    }));
  });
}
