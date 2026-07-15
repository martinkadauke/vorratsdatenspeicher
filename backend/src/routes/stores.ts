import type { FastifyInstance } from 'fastify';
import sql, { DEMO_MODE, withHousehold } from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { loadUnits, comparisonGroups, type PriceLine } from '../lib/units.js';
import { discoverStoresForHousehold, addStoreByName } from '../stores/discover.js';
import { enrichStores } from '../stores/enrich.js';

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
       ${kontoScope(req.user, sql`e`)}
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
        f.id, f.chain_key, f.name, f.kind, f.address, f.lat, f.lon, f.website, f.phone,
        f.opening_hours, f.prospectus_url, f.warengruppen, f.subscribed,
        COUNT(e.id)::int                                 AS receipts,
        COALESCE(SUM(e.gesamt_betrag), 0)::numeric(10,2)  AS total,
        MAX(e.datum)                                     AS last_visit
      FROM store_branch f
      LEFT JOIN einkauf e
        ON e.branch_id = f.id
       ${kontoScope(req.user, sql`e`)}
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
    const body = (req.body ?? {}) as { address?: string | null; warengruppen?: unknown; opening_hours?: string | null };

    const updates: Record<string, unknown> = {};
    if ('address' in body) updates.address = (body.address ?? '').toString().trim() || null;
    if ('opening_hours' in body) {
      const txt = (body.opening_hours ?? '').toString().trim();
      // free-text for now (manual entry); a weekly cron can fill structured data later
      updates.opening_hours = txt ? JSON.stringify({ text: txt }) : null;
    }
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
      // sql.json() → stored as a real jsonb ARRAY. (JSON.stringify into a jsonb
      // column gets re-encoded by postgres.js into a jsonb STRING, which then reads
      // back as a string and the editor showed the saved order as empty.)
      updates.warengruppen = sql.json(cleaned);
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    updates.updated_at = new Date();

    const [row] = await sql`
      UPDATE store_branch SET ${sql(updates)} WHERE id = ${id}
      RETURNING id, address, warengruppen, opening_hours
    `;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { ok: true, ...row };
  });

  /** Remove a store branch (e.g. an auto-discovered OSM store the user doesn't want on
   *  their Läden list). Deletes only the store_branch metadata row — receipt history keyed
   *  by roh_ladenname is untouched, so a store that later reappears on a receipt still shows.
   *  RLS-scoped to the household on demo; plain by id off-demo. */
  app.delete('/api/filialen/:id', async (req, reply) => {
    if (req.user?.can_write === false) return reply.code(403).send({ error: 'forbidden' });
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const rows = await sql`DELETE FROM store_branch WHERE id = ${id} RETURNING id, name`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true, id, name: rows[0].name as string };
  });

  /** List all stores ever seen with receipt count + total spend. */
  app.get('/api/stores', async (req) => {
    // E-mail receipts are online shops (filed as kind='shop'); by default they're
    // kept out so the physical-Filialen list stays clean. `?shops=1` includes them
    // too (used by the Positionen filter, which offers Läden AND Shops).
    const includeShops = (req.query as { shops?: string }).shops === '1';
    const rows = await sql`
      SELECT e.roh_ladenname, COUNT(*)::int AS receipts, SUM(e.gesamt_betrag)::numeric(10,2) AS total,
             MAX(sb.id) AS branch_id
      FROM einkauf e
      LEFT JOIN store_branch sb ON sb.name = e.roh_ladenname AND sb.kind = 'filiale'
      WHERE e.roh_ladenname IS NOT NULL
        ${includeShops ? sql`` : sql`AND e.quelle IS DISTINCT FROM 'email'`}
        ${kontoScope(req.user, sql`e`)}
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
    // Surface household store_branch rows that have NO receipts yet, so a brand-new household's
    // OSM-discovered / manually-added stores appear on the Läden list. REQUIRE coordinates:
    // every discovered/added store is geocoded (lat/lon set), whereas receipt-orphans and stray
    // test fixtures (ZZTEST, dropfolder refs, deleted-receipt branches) have none — so this
    // shows only real, intentionally-added stores and never that junk. RLS-scoped on demo.
    const seenNames = new Set(rows.map(r => r.roh_ladenname as string));
    const branches = await sql`SELECT id, name FROM store_branch WHERE kind = 'filiale' AND lat IS NOT NULL`;
    for (const b of branches) {
      const name = b.name as string;
      if (seenNames.has(name)) continue;
      const key = normalizeStore(name);
      if (!key) continue;
      const e = grouped.get(key) ?? { receipts: 0, total: 0, filialen: [] };
      if (e.filialen.some(f => f.name === name)) continue;
      e.filialen.push({ name, receipts: 0, total: 0, branch_id: b.id as number });
      grouped.set(key, e);
    }
    const typeMap = new Map((await sql`SELECT store_key, store_type FROM store_meta WHERE store_type IS NOT NULL`)
      .map(r => [r.store_key as string, r.store_type as string]));
    return [...grouped.entries()]
      .map(([key, v]) => {
        const filialen = v.filialen.sort((a, b) => b.receipts - a.receipts);
        return {
          key,
          store_type: typeMap.get(key) ?? null, // drives shopping-list suggestion scoping
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

  /** Discover supermarkets/drugstores near the household address (OSM) and add them as
   *  branches, so a fresh household has stores for the Läden list + offers-by-store. */
  app.post('/api/stores/discover', async (req, reply) => {
    if (req.user?.can_write === false) return reply.code(403).send({ error: 'forbidden' });
    return discoverStoresForHousehold();
  });

  /** Enrichment runner: auto-fill address/website/phone for ALL of the household's stores +
   *  shops (OSM for physical branches, web-search for websites). Runs in the BACKGROUND, so on
   *  demo it holds its own household-scoped connection (like the offer search). */
  app.post('/api/stores/enrich', async (req, reply) => {
    if (req.user?.can_write === false) return reply.code(403).send({ error: 'forbidden' });
    if (DEMO_MODE) {
      const hid = req.user!.household_id ?? 1;
      void withHousehold(hid, () => enrichStores()).catch(err => req.log.error(`store enrich failed: ${err.message}`));
    } else {
      void enrichStores().catch(err => req.log.error(`store enrich failed: ${err.message}`));
    }
    return { ok: true, started: true };
  });

  /** Add a single named store near the household address (OSM lookup: "<name>" near home). */
  app.post('/api/stores/add', async (req, reply) => {
    if (req.user?.can_write === false) return reply.code(403).send({ error: 'forbidden' });
    const name = String((req.body as { name?: string })?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (name.length > 80) return reply.code(400).send({ error: 'name too long' });
    return addStoreByName(name);
  });

  /** Set/clear a chain's store-type (Supermarkt/Drogerie/…) — drives which shopping
   *  list a low product is suggested on (history × list type). */
  app.put('/api/stores/:key/type', async (req, reply) => {
    const key = decodeURIComponent((req.params as { key: string }).key).toLowerCase();
    const { store_type } = (req.body ?? {}) as { store_type?: string | null };
    if (store_type === undefined) return reply.code(400).send({ error: 'store_type required (or null to clear)' });
    const type = (store_type ?? '').trim() || null;
    await sql`
      INSERT INTO store_meta (store_key, store_type, updated_at, updated_by)
      VALUES (${key}, ${type}, NOW(), ${req.user?.id ?? null})
      ON CONFLICT (store_key) DO UPDATE
        SET store_type = EXCLUDED.store_type, updated_at = NOW(), updated_by = EXCLUDED.updated_by`;
    return { ok: true };
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
      // Null the icon but KEEP the row — store_type now lives here too and must survive.
      await sql`UPDATE store_meta SET icon_url = NULL, source = NULL, updated_at = NOW(), updated_by = ${req.user?.id ?? null} WHERE store_key = ${key}`;
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

  /** Price history of a canonical_name per store, as unit-aware comparison
   *  prices (€/kg, €/l, €/Stück). The headline `avg_eur`/`unit` per store is the
   *  product's base_unit group (falls back to the most-used group). */
  app.get('/api/stores/price-history', async (req, reply) => {
    const name = (req.query as { canonical?: string }).canonical;
    if (!name) return reply.code(400).send({ error: 'canonical required' });

    const units = await loadUnits();
    const [meta] = await sql`SELECT base_unit FROM canonical_meta WHERE canonical_name = ${name}`;
    const baseUnit = (meta?.base_unit as string | null) ?? null;
    const keyFor = (n: string | null): string | null => {
      if (!n) return null;
      const u = units.get(n);
      return u ? (u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name) : null;
    };
    const buKey = keyFor(baseUnit);

    const rows = await sql`
      SELECT e.roh_ladenname AS store, a.preis, a.menge, a.einheit
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.canonical_name = ${name} AND a.preis IS NOT NULL AND a.preis > 0
        ${kontoScope(req.user, sql`e`)}
    `;

    const byStore = new Map<string, { display: string; lines: PriceLine[] }>();
    for (const r of rows) {
      const key = normalizeStore(r.store as string);
      if (!key) continue;
      const e = byStore.get(key) ?? { display: r.store as string, lines: [] };
      e.lines.push(r as unknown as PriceLine);
      byStore.set(key, e);
    }

    const stores = [...byStore.entries()].map(([key, v]) => {
      const groups = comparisonGroups(v.lines, units);
      const headline = (buKey ? groups.find(g => g.unit === buKey) : undefined) ?? groups[0] ?? null;
      return { key, display: v.display, avg_eur: headline?.avg ?? 0, unit: headline?.unit ?? null, groups };
    }).filter(s => s.groups.length);

    // Cheapest compared within the base_unit group (only stores that have it).
    const buAvg = (s: typeof stores[number]) =>
      (buKey ? s.groups.find(g => g.unit === buKey)?.avg : s.avg_eur) ?? Infinity;
    const cheapest = [...stores].sort((a, b) => buAvg(a) - buAvg(b)).find(s => Number.isFinite(buAvg(s))) ?? null;
    return { canonical: name, base_unit: baseUnit, stores, cheapest };
  });
}
