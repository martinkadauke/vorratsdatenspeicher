import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { searchFilter, col, numCol, lk } from '../lib/search.js';
import { recordAliases } from '../lib/canonicalAlias.js';

export function nameRoutes(app: FastifyInstance): void {
  app.get('/api/names', async (req) => {
    const q = (req.query as { q?: string }).q?.trim() ?? '';
    const rows = await sql`
      SELECT a.canonical_name,
             COUNT(*)::int AS artikel_count,
             mode() WITHIN GROUP (ORDER BY a.category_path) AS category_path,
             MAX(e.datum)::text AS last_bought
      FROM artikel a
      LEFT JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.canonical_name IS NOT NULL
        ${searchFilter(q, {
          text: [
            col(sql`a.canonical_name`),
            p => sql`EXISTS (SELECT 1 FROM canonical_translation ct
                            WHERE ct.canonical_name = a.canonical_name AND ${lk(sql`ct.translated`, p)})`,
          ],
          fields: { kategorie: col(sql`a.category_path`) },
        })}
        ${kontoScope(req.user, sql`e.konto_id`)}
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

  /** Grouped article list for the Artikel page. Articles collapse by canonical
   *  name when present, else by ai_guess/name. Returns purchase stats + the
   *  artikel_ids backing each group (for bulk operations). Konto-scoped. */
  app.get('/api/artikel-list', async (req) => {
    const search = (req.query as { q?: string }).q?.trim() ?? '';
    const rows = await sql`
      SELECT
        CASE WHEN a.canonical_name IS NOT NULL THEN 'c:' || a.canonical_name
             ELSE 'g:' || COALESCE(NULLIF(a.ai_guess, ''), a.name, '?') END AS grp,
        bool_or(a.canonical_name IS NOT NULL) AS has_canonical,
        MAX(a.canonical_name) AS canonical_name,
        COALESCE(MAX(a.canonical_name), MAX(NULLIF(a.ai_guess, '')), MAX(a.name)) AS display,
        COUNT(*)::int AS count,
        mode() WITHIN GROUP (ORDER BY a.category_path) AS category,
        MAX(e.datum)::text AS last_bought,
        ROUND(AVG(a.preis) FILTER (WHERE a.preis > 0), 2) AS avg_price,
        array_agg(a.id) AS artikel_ids,
        (array_agg(a.einkauf_id ORDER BY e.datum DESC, a.id DESC))[1] AS einkauf_id,
        (array_agg(a.id ORDER BY e.datum DESC, a.id DESC))[1] AS sample_artikel_id
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE TRUE
        ${searchFilter(search, {
          text: [col(sql`a.canonical_name`), col(sql`a.ai_guess`), col(sql`a.name`), col(sql`a.original_text`)],
          fields: { kategorie: col(sql`a.category_path`), laden: col(sql`e.roh_ladenname`) },
          nums: { preis: numCol(sql`a.preis`) },
        })}
        ${kontoScope(req.user, sql`e.konto_id`)}
      GROUP BY grp
    `;

    // Consumer dots: canonical groups read canonical_consumer.
    const canonicals = rows.map(r => r.canonical_name).filter(Boolean) as string[];
    const consumers = canonicals.length ? await sql`
      SELECT canonical_name, family_member_id, is_exclusive FROM canonical_consumer
      WHERE canonical_name IN ${sql(canonicals)}
    ` : [];
    const coMap = new Map<string, number[]>();
    for (const c of consumers) {
      const arr = coMap.get(c.canonical_name as string) ?? [];
      arr.push(c.family_member_id as number);
      coMap.set(c.canonical_name as string, arr);
    }

    return rows.map(r => ({
      key: r.grp,
      display: r.display,
      has_canonical: r.has_canonical,
      canonical_name: r.canonical_name,
      count: r.count,
      category: r.category,
      last_bought: r.last_bought,
      avg_price: r.avg_price,
      artikel_ids: r.artikel_ids,
      einkauf_id: r.einkauf_id,
      sample_artikel_id: r.sample_artikel_id,
      consumers: r.canonical_name ? (coMap.get(r.canonical_name as string) ?? []) : [],
    }));
  });

  /** Household-wide "avoid" list (artikel_ausschluss): products we decided not
   *  to buy. Used to warn on receipts and to keep them off shopping suggestions. */
  app.get('/api/avoided', async () => {
    const rows = await sql`SELECT canonical_name FROM artikel_ausschluss ORDER BY canonical_name`;
    return rows.map(r => r.canonical_name as string);
  });

  /** Add/remove canonical names from the avoid list. Body: { canonical_names, avoid }. */
  app.post('/api/avoided', async (req, reply) => {
    const { canonical_names, avoid } = (req.body ?? {}) as { canonical_names?: string[]; avoid?: boolean };
    if (!Array.isArray(canonical_names) || !canonical_names.length || typeof avoid !== 'boolean') {
      return reply.code(400).send({ error: 'canonical_names[] and avoid (bool) required' });
    }
    await sql.begin(async tx => {
      for (const cn of canonical_names) {
        if (avoid) {
          await tx`INSERT INTO artikel_ausschluss (canonical_name) VALUES (${cn}) ON CONFLICT DO NOTHING`;
          await tx`DELETE FROM einkaufsliste WHERE canonical_name = ${cn}`; // also drop from the shopping list
        } else {
          await tx`DELETE FROM artikel_ausschluss WHERE canonical_name = ${cn}`;
        }
      }
    });
    return { ok: true, avoided: avoid, count: canonical_names.length };
  });

  /** Bulk-set a canonical name on the selected articles' artikel_ids.
   *  Konto-scoped. Trims whitespace. */
  app.post('/api/artikel/set-canonical', async (req, reply) => {
    const { artikel_ids, canonical_name } = (req.body ?? {}) as { artikel_ids?: number[]; canonical_name?: string };
    const name = canonical_name?.trim();
    if (!name) return reply.code(400).send({ error: 'canonical_name required' });
    if (!Array.isArray(artikel_ids) || !artikel_ids.length) return reply.code(400).send({ error: 'artikel_ids required' });
    const rows = await sql`
      UPDATE artikel a SET canonical_name = ${name}
      FROM einkauf e
      WHERE a.einkauf_id = e.id AND a.id IN ${sql(artikel_ids)}
        ${kontoScope(req.user, sql`e.konto_id`)}
      RETURNING a.id, a.original_text, a.name
    `;
    // learn each OCR text → canonical so future scans match without the LLM
    await recordAliases(rows.map(r => [(r.original_text as string) ?? (r.name as string), name]));
    return { ok: true, updated: rows.length };
  });

  /** Bulk-set the category on the selected articles' artikel_ids. Konto-scoped. */
  app.post('/api/artikel/set-category', async (req, reply) => {
    const { artikel_ids, category_path } = (req.body ?? {}) as { artikel_ids?: number[]; category_path?: string };
    if (!category_path) return reply.code(400).send({ error: 'category_path required' });
    if (!Array.isArray(artikel_ids) || !artikel_ids.length) return reply.code(400).send({ error: 'artikel_ids required' });
    const rows = await sql`
      UPDATE artikel a SET category_path = ${category_path}
      FROM einkauf e
      WHERE a.einkauf_id = e.id AND a.id IN ${sql(artikel_ids)}
        ${kontoScope(req.user, sql`e.konto_id`)}
      RETURNING a.id
    `;
    return { ok: true, updated: rows.length };
  });

  /** Bulk-assign family members to selected articles. Canonical groups set
   *  canonical_consumer (cascades to future buys); loose artikel set
   *  artikel_consumer. Konto-scoped — only touches artikel the user can see. */
  app.post('/api/artikel/assign-consumers', async (req, reply) => {
    const { canonical_names, artikel_ids, member_ids } = (req.body ?? {}) as {
      canonical_names?: string[]; artikel_ids?: number[]; member_ids?: number[];
    };
    if (!Array.isArray(member_ids)) return reply.code(400).send({ error: 'member_ids required' });
    const cns = Array.isArray(canonical_names) ? canonical_names : [];
    const aids = Array.isArray(artikel_ids) ? artikel_ids : [];

    await sql.begin(async tx => {
      for (const cn of cns) {
        await tx`DELETE FROM canonical_consumer WHERE canonical_name = ${cn}`;
        for (const m of member_ids) {
          await tx`INSERT INTO canonical_consumer (canonical_name, family_member_id, is_exclusive)
                   VALUES (${cn}, ${m}, FALSE) ON CONFLICT DO NOTHING`;
        }
      }
      if (aids.length) {
        // Only loose artikel the caller may see.
        const visible = (await tx`
          SELECT a.id FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
          WHERE a.id IN ${tx(aids)} ${kontoScope(req.user, tx`e.konto_id`)}
        `).map(r => r.id as number);
        for (const aid of visible) {
          await tx`DELETE FROM artikel_consumer WHERE artikel_id = ${aid}`;
          for (const m of member_ids) {
            await tx`INSERT INTO artikel_consumer (artikel_id, family_member_id)
                     VALUES (${aid}, ${m}) ON CONFLICT DO NOTHING`;
          }
        }
      }
    });
    return { ok: true };
  });
}
