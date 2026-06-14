import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { searchFilter, col, numCol, lk } from '../lib/search.js';
import { recordAliases } from '../lib/canonicalAlias.js';
import { loadUnits, comparisonGroups, type PriceLine } from '../lib/units.js';

export function nameRoutes(app: FastifyInstance): void {
  app.get('/api/names', async (req) => {
    const q = (req.query as { q?: string }).q?.trim() ?? '';
    const rows = await sql`
      SELECT a.canonical_name,
             COUNT(*)::int AS artikel_count,
             mode() WITHIN GROUP (ORDER BY a.category_path) AS category_path,
             MAX(cm.base_unit) AS base_unit,
             MAX(e.datum)::text AS last_bought
      FROM artikel a
      LEFT JOIN einkauf e ON e.id = a.einkauf_id
      LEFT JOIN canonical_meta cm ON cm.canonical_name = a.canonical_name
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
    const fq = req.query as { q?: string; category?: string; from?: string; to?: string; konto?: string };
    const search = fq.q?.trim() ?? '';
    const catFilter = fq.category ? sql`AND a.category_path LIKE ${fq.category + '%'}` : sql``;
    const fromFilter = fq.from ? sql`AND e.datum >= ${fq.from}` : sql``;
    const toFilter = fq.to ? sql`AND e.datum <= ${fq.to}` : sql``;
    const kontoId = fq.konto ? parseInt(fq.konto, 10) : null;
    const kontoFilter = kontoId ? sql`AND e.konto_id = ${kontoId}` : sql``;
    const rows = await sql`
      SELECT
        CASE WHEN a.canonical_name IS NOT NULL THEN 'c:' || a.canonical_name
             ELSE 'g:' || COALESCE(NULLIF(a.ai_guess, ''), a.name, '?') END AS grp,
        bool_or(a.canonical_name IS NOT NULL) AS has_canonical,
        bool_or(a.user_corrected) AS user_corrected,
        MAX(a.canonical_name) AS canonical_name,
        COALESCE(MAX(a.canonical_name), MAX(NULLIF(a.ai_guess, '')), MAX(a.name)) AS display,
        COUNT(*)::int AS count,
        mode() WITHIN GROUP (ORDER BY a.category_path) AS category,
        MAX(e.datum)::text AS last_bought,
        ROUND(AVG(COALESCE(a.preis / NULLIF(a.menge, 0), a.preis)) FILTER (WHERE a.preis > 0), 2) AS avg_price,
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
        ${catFilter} ${fromFilter} ${toFilter} ${kontoFilter}
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

    // Per-product base_unit + hidden flag, and a unit-aware comparison price
    // (€/kg, €/l, €/Stück) built from all of the product's purchases (konto-scoped).
    const meta = canonicals.length ? await sql`
      SELECT canonical_name, base_unit, hidden FROM canonical_meta WHERE canonical_name IN ${sql(canonicals)}
    ` : [];
    const metaMap = new Map(meta.map(m => [m.canonical_name as string, m]));
    const units = await loadUnits();
    const keyFor = (n: string | null | undefined): string | null => {
      if (!n) return null;
      const u = units.get(n);
      return u ? (u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name) : null;
    };
    const lineRows = canonicals.length ? await sql`
      SELECT a.canonical_name, a.preis, a.menge, a.einheit
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.canonical_name IN ${sql(canonicals)} ${kontoScope(req.user, sql`e.konto_id`)}
    ` : [];
    const linesByCanon = new Map<string, PriceLine[]>();
    for (const l of lineRows as unknown as (PriceLine & { canonical_name: string })[]) {
      const arr = linesByCanon.get(l.canonical_name) ?? [];
      arr.push(l);
      linesByCanon.set(l.canonical_name, arr);
    }

    return rows.map(r => {
      const cn = r.canonical_name as string | null;
      const m = cn ? metaMap.get(cn) : undefined;
      const baseUnit = (m?.base_unit as string | null) ?? null;
      const groups = cn ? comparisonGroups(linesByCanon.get(cn) ?? [], units) : [];
      const buKey = keyFor(baseUnit);
      const comparison = (buKey ? groups.find(g => g.unit === buKey) : undefined) ?? groups[0] ?? null;
      // Product is meant to be compared per kg/l (Grundpreis), but we have no
      // purchase line in that dimension → can't compute €/kg (weights missing).
      const needs_weight = (buKey === 'kg' || buKey === 'l') && !groups.some(g => g.unit === buKey);
      return {
        key: r.grp,
        display: r.display,
        has_canonical: r.has_canonical,
        user_corrected: r.user_corrected,
        canonical_name: cn,
        count: r.count,
        category: r.category,
        last_bought: r.last_bought,
        avg_price: r.avg_price,
        base_unit: baseUnit,
        hidden: (m?.hidden as boolean | undefined) ?? false,
        comparison: comparison ? { unit: comparison.unit, avg: comparison.avg } : null,
        needs_weight,
        groups,
        artikel_ids: r.artikel_ids,
        einkauf_id: r.einkauf_id,
        sample_artikel_id: r.sample_artikel_id,
        consumers: cn ? (coMap.get(cn) ?? []) : [],
      };
    });
  });

  /** Set per-product metadata: base_unit (Grundpreis-Einheit) and/or hidden. */
  app.patch('/api/names/:name/meta', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const body = (req.body ?? {}) as { base_unit?: string | null; hidden?: boolean };
    if (!('base_unit' in body) && !('hidden' in body)) {
      return reply.code(400).send({ error: 'nothing to update' });
    }
    if ('base_unit' in body) {
      await sql`
        INSERT INTO canonical_meta (canonical_name, base_unit, updated_at, updated_by)
        VALUES (${name}, ${body.base_unit ?? null}, NOW(), ${req.user!.id})
        ON CONFLICT (canonical_name) DO UPDATE SET base_unit = EXCLUDED.base_unit, updated_at = NOW(), updated_by = EXCLUDED.updated_by`;
    }
    if ('hidden' in body) {
      await sql`
        INSERT INTO canonical_meta (canonical_name, hidden, updated_at, updated_by)
        VALUES (${name}, ${!!body.hidden}, NOW(), ${req.user!.id})
        ON CONFLICT (canonical_name) DO UPDATE SET hidden = EXCLUDED.hidden, updated_at = NOW(), updated_by = EXCLUDED.updated_by`;
    }
    return { ok: true };
  });

  /** Total spend for the same filters as artikel-list (category + date range +
   *  search). Powers "how much on meat in 3 weeks / Jan–Apr / June". */
  app.get('/api/artikel-spend', async (req) => {
    const fq = req.query as { q?: string; category?: string; from?: string; to?: string; konto?: string };
    const search = fq.q?.trim() ?? '';
    const catFilter = fq.category ? sql`AND a.category_path LIKE ${fq.category + '%'}` : sql``;
    const fromFilter = fq.from ? sql`AND e.datum >= ${fq.from}` : sql``;
    const toFilter = fq.to ? sql`AND e.datum <= ${fq.to}` : sql``;
    const kontoId = fq.konto ? parseInt(fq.konto, 10) : null;
    const kontoFilter = kontoId ? sql`AND e.konto_id = ${kontoId}` : sql``;
    const [row] = await sql`
      SELECT COUNT(*)::int AS items,
             COALESCE(SUM(a.preis) FILTER (WHERE a.preis > 0), 0)::numeric(10,2) AS total
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE TRUE
        ${searchFilter(search, {
          text: [col(sql`a.canonical_name`), col(sql`a.ai_guess`), col(sql`a.name`), col(sql`a.original_text`)],
          fields: { kategorie: col(sql`a.category_path`), laden: col(sql`e.roh_ladenname`) },
          nums: { preis: numCol(sql`a.preis`) },
        })}
        ${catFilter} ${fromFilter} ${toFilter} ${kontoFilter}
        ${kontoScope(req.user, sql`e.konto_id`)}
    `;
    return { items: row.items, total: row.total };
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
      UPDATE artikel a SET canonical_name = ${name}, user_corrected = TRUE
      FROM einkauf e
      WHERE a.einkauf_id = e.id AND a.id IN ${sql(artikel_ids)}
        ${kontoScope(req.user, sql`e.konto_id`)}
      RETURNING a.id, a.original_text, a.name
    `;
    // learn each OCR text → canonical so future scans match without the LLM
    await recordAliases(rows.map(r => [(r.original_text as string) ?? (r.name as string), name]), true);
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
