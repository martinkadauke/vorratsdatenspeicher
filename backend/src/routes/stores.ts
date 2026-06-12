import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';

/** Normalize free-text store name into a stable key for grouping.
 *  "LIDL", "Lidl", "Lidl GmbH" → "lidl". */
function normalizeStore(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/gmbh|kg|ag|co\.?|&|\bservice\b/gi, '')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim()
    .split(/\s+/)[0] ?? '';
}

/** Longest common leading word sequence across branch names → chain display.
 *  Single branch returns its full name. */
function chainDisplay(names: string[]): string {
  if (names.length === 1) return names[0].replace(/\s+(gmbh|kg|ag)\b.*/i, '').trim();
  const wordLists = names.map(n => n.replace(/\s+(gmbh|kg|ag)\b.*/i, '').trim().split(/\s+/));
  const first = wordLists[0];
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const w = first[i];
    if (wordLists.every(wl => (wl[i] ?? '').toLowerCase() === w.toLowerCase())) common.push(w);
    else break;
  }
  return common.length ? common.join(' ') : first[0];
}

export function storeRoutes(app: FastifyInstance): void {
  /** List filiale/shop entities (auto-created on first receipt) with the
   *  user-visible receipt count + spend. `?kind=filiale|shop` filters;
   *  default returns physical branches. The profile editor (address,
   *  warengruppen ordering, …) is built on top of this in a later schub. */
  app.get('/api/filialen', async (req) => {
    const kind = (req.query as { kind?: string }).kind ?? 'filiale';
    return sql`
      SELECT
        f.id, f.chain_key, f.name, f.kind,
        f.address, f.opening_hours, f.prospectus_url, f.warengruppen, f.subscribed,
        COUNT(e.id)::int                       AS receipts,
        COALESCE(SUM(e.gesamt_betrag), 0)::numeric(10,2) AS total,
        MAX(e.datum)                           AS last_visit
      FROM store_branch f
      LEFT JOIN einkauf e
        ON e.branch_id = f.id
       ${kontoScope(req.user, sql`e.konto_id`)}
      WHERE f.kind = ${kind}
      GROUP BY f.id
      HAVING COUNT(e.id) > 0
      ORDER BY receipts DESC, f.name
    `;
  });

  /** Single branch profile: the entity + user-visible spend stats. */
  app.get('/api/filialen/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const [row] = await sql`
      SELECT
        f.id, f.chain_key, f.name, f.kind, f.address, f.lat, f.lon,
        f.opening_hours, f.prospectus_url, f.warengruppen, f.subscribed,
        COUNT(e.id)::int                                 AS receipts,
        COALESCE(SUM(e.gesamt_betrag), 0)::numeric(10,2)  AS total,
        MAX(e.datum)                                     AS last_visit
      FROM store_branch f
      LEFT JOIN einkauf e
        ON e.branch_id = f.id
       ${kontoScope(req.user, sql`e.konto_id`)}
      WHERE f.id = ${id}
      GROUP BY f.id
    `;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return row;
  });

  /** Update an editable branch profile field. Currently address + the tiered
   *  warengruppen ordering ([[catPathA, catPathB], [catPathC]] — each tier is a
   *  set of categories treated as equal/parallel). */
  app.patch('/api/filialen/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const body = (req.body ?? {}) as { address?: string | null; warengruppen?: unknown };

    const updates: Record<string, unknown> = {};
    if ('address' in body) updates.address = (body.address ?? '').toString().trim() || null;
    if ('warengruppen' in body) {
      const wg = body.warengruppen;
      // must be an array of arrays of strings (tiers of category paths)
      const valid = Array.isArray(wg) && wg.every(tier =>
        Array.isArray(tier) && tier.every(c => typeof c === 'string'));
      if (!valid) return reply.code(400).send({ error: 'warengruppen must be string[][]' });
      // drop empty tiers, trim, de-dupe within a tier
      const cleaned = (wg as string[][])
        .map(tier => [...new Set(tier.map(c => c.trim()).filter(Boolean))])
        .filter(tier => tier.length);
      updates.warengruppen = JSON.stringify(cleaned);
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    updates.updated_at = new Date();

    const [row] = await sql`
      UPDATE store_branch SET ${sql(updates)} WHERE id = ${id}
      RETURNING id, address, warengruppen
    `;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { ok: true, ...row };
  });

  /** List all stores ever seen with receipt count + total spend. */
  app.get('/api/stores', async (req) => {
    const rows = await sql`
      SELECT e.roh_ladenname, COUNT(*)::int AS receipts, SUM(e.gesamt_betrag)::numeric(10,2) AS total,
             MAX(sb.id) AS branch_id
      FROM einkauf e
      LEFT JOIN store_branch sb ON sb.name = e.roh_ladenname AND sb.kind = 'filiale'
      WHERE e.roh_ladenname IS NOT NULL
        ${kontoScope(req.user, sql`e.konto_id`)}
      GROUP BY e.roh_ladenname
      ORDER BY receipts DESC
    `;
    // Group by normalized name in JS so "LIDL" + "Lidl GmbH" merge.
    // Each distinct roh_ladenname becomes a "filiale" (branch) under the chain.
    interface Filiale { name: string; receipts: number; total: number; branch_id: number | null }
    const grouped = new Map<string, { receipts: number; total: number; filialen: Filiale[] }>();
    for (const r of rows) {
      const key = normalizeStore(r.roh_ladenname as string);
      if (!key) continue;
      const e = grouped.get(key) ?? { receipts: 0, total: 0, filialen: [] };
      e.receipts += r.receipts;
      e.total += Number(r.total ?? 0);
      e.filialen.push({ name: r.roh_ladenname as string, receipts: r.receipts, total: Number(r.total ?? 0), branch_id: (r.branch_id as number | null) ?? null });
      grouped.set(key, e);
    }
    return [...grouped.entries()]
      .map(([key, v]) => {
        const filialen = v.filialen.sort((a, b) => b.receipts - a.receipts);
        return {
          key,
          // Chain display = the common leading word(s) across all branches
          // ("LIDL Tübingen" + "Lidl Gomaringen" → "LIDL"). A single branch
          // keeps its full name (don't truncate "Café Bäcker Mayer").
          display: chainDisplay(filialen.map(f => f.name)),
          receipts: v.receipts, total: v.total,
          filialen,
          raw: filialen.map(f => f.name), // kept for the rename/merge modal
        };
      })
      .sort((a, b) => b.receipts - a.receipts);
  });

  /** Store icon: get one. */
  app.get('/api/stores/:key/icon', async (req) => {
    const key = decodeURIComponent((req.params as { key: string }).key).toLowerCase();
    const rows = await sql`SELECT icon_url, source FROM store_meta WHERE store_key = ${key}`;
    return rows[0] ?? { icon_url: null, source: null };
  });

  /** Store icon: set or clear. */
  app.put('/api/stores/:key/icon', async (req, reply) => {
    const key = decodeURIComponent((req.params as { key: string }).key).toLowerCase();
    const { icon_url, source } = (req.body ?? {}) as { icon_url?: string | null; source?: string };
    if (icon_url === undefined) return reply.code(400).send({ error: 'icon_url required (or null to clear)' });
    if (!icon_url) {
      await sql`DELETE FROM store_meta WHERE store_key = ${key}`;
      return { ok: true, cleared: true };
    }
    await sql`
      INSERT INTO store_meta (store_key, icon_url, source, updated_at, updated_by)
      VALUES (${key}, ${icon_url}, ${source ?? 'manual'}, NOW(), ${req.user?.id ?? null})
      ON CONFLICT (store_key) DO UPDATE
        SET icon_url = EXCLUDED.icon_url, source = EXCLUDED.source,
            updated_at = NOW(), updated_by = EXCLUDED.updated_by
    `;
    return { ok: true };
  });

  /** Bulk read of store icons for a list of normalized keys. */
  app.get('/api/stores/icons', async (req) => {
    const keysParam = (req.query as { keys?: string }).keys ?? '';
    if (!keysParam) return {};
    const keys = keysParam.split(',').filter(Boolean).map(k => k.toLowerCase());
    if (!keys.length) return {};
    const rows = await sql`
      SELECT store_key, icon_url FROM store_meta
      WHERE store_key IN ${sql(keys)} AND icon_url IS NOT NULL
    `;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.store_key as string] = r.icon_url as string;
    return out;
  });

  /** Rename a store — cascades to every einkauf.roh_ladenname that matches. */
  app.put('/api/stores/:rawname/rename', async (req, reply) => {
    const oldName = decodeURIComponent((req.params as { rawname: string }).rawname);
    const { new_name } = (req.body ?? {}) as { new_name?: string };
    if (!new_name) return reply.code(400).send({ error: 'new_name required' });
    const result = await sql`
      UPDATE einkauf SET roh_ladenname = ${new_name} WHERE roh_ladenname = ${oldName}
      RETURNING id
    `;
    return { ok: true, updated: result.length };
  });

  /** Merge: move every einkauf from `from` to `to` (target name). */
  app.post('/api/stores/merge', async (req, reply) => {
    const { from, to } = (req.body ?? {}) as { from?: string[]; to?: string };
    if (!Array.isArray(from) || !from.length || !to) return reply.code(400).send({ error: 'from[] and to required' });
    const result = await sql`
      UPDATE einkauf SET roh_ladenname = ${to} WHERE roh_ladenname IN ${sql(from)}
      RETURNING id
    `;
    return { ok: true, updated: result.length };
  });

  /** Price history of a canonical_name per store.
   *  Returns avg price per (store, month) plus the cheapest store overall. */
  app.get('/api/stores/price-history', async (req, reply) => {
    const name = (req.query as { canonical?: string }).canonical;
    if (!name) return reply.code(400).send({ error: 'canonical required' });

    const rows = await sql`
      SELECT
        e.roh_ladenname AS store,
        to_char(e.datum, 'YYYY-MM') AS ym,
        AVG(a.preis)::numeric(10,2) AS avg_eur,
        MIN(a.preis)::numeric(10,2) AS min_eur,
        COUNT(*)::int AS n
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.canonical_name = ${name}
        AND a.preis IS NOT NULL
        AND a.preis > 0
        ${kontoScope(req.user, sql`e.konto_id`)}
      GROUP BY e.roh_ladenname, ym
      ORDER BY ym DESC, store
    `;

    // group by normalized store key
    const byStore = new Map<string, { display: string; points: { ym: string; avg: number; min: number; n: number }[] }>();
    for (const r of rows) {
      const key = normalizeStore(r.store as string);
      if (!key) continue;
      const e = byStore.get(key) ?? { display: r.store as string, points: [] };
      e.points.push({ ym: r.ym as string, avg: Number(r.avg_eur), min: Number(r.min_eur), n: r.n });
      byStore.set(key, e);
    }

    const stores = [...byStore.entries()].map(([key, v]) => {
      const avgPrice = v.points.reduce((s, p) => s + p.avg * p.n, 0) /
                       v.points.reduce((s, p) => s + p.n, 0);
      return { key, display: v.display, avg_eur: round2(avgPrice), points: v.points };
    });

    const cheapest = [...stores].sort((a, b) => a.avg_eur - b.avg_eur)[0] ?? null;
    return { canonical: name, stores, cheapest };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
