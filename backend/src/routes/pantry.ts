import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { loadUnits, normalizeEinheit, comparisonGroups, type PriceLine } from '../lib/units.js';
import { estimateVorrat } from '../lib/vorrat.js';

/** "LIDL", "Lidl GmbH" → "lidl" (mirrors routes/stores.ts normalizeStore). */
function normalizeStore(raw: string): string {
  return (raw ?? '').toLowerCase().replace(/gmbh|kg|ag|co\.?|&|\bservice\b/gi, '').replace(/[^a-z0-9äöüß]+/g, ' ').trim().split(/\s+/)[0] ?? '';
}
/** "0,99 €" / "1.299,00 €" → 0.99 / 1299 (mirrors routes/offers.ts parsePrice). */
function parsePrice(s: string | null): number | null {
  if (!s) return null;
  const n = parseFloat(s.replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

type Units = Awaited<ReturnType<typeof loadUnits>>;

/** Comparison-group key for a unit name: mass→kg, volume→l, count→itself. */
function unitKey(units: Units, name: string | null | undefined): string | null {
  if (!name) return null;
  const u = units.get(name);
  if (!u) return null;
  return u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name;
}

type ScopeUser = Parameters<typeof kontoScope>[0];

/** Live stock estimate for every product opted into tracking (track_vorrat),
 *  computed in-app from purchase history + any manual override. Shared by
 *  /api/pantry and /api/alerts. */
async function trackedVorrat(user: ScopeUser) {
  const tracked = (await sql`
    SELECT canonical_name, base_unit, reserve_min::float8 AS reserve_min, vorrat_sort
    FROM canonical_meta WHERE track_vorrat = TRUE
  `).map(r => ({ canonical_name: r.canonical_name as string, base_unit: r.base_unit as string | null, reserve_min: r.reserve_min as number | null, vorrat_sort: r.vorrat_sort as number | null }));
  if (!tracked.length) return [];
  const canons = tracked.map(tk => tk.canonical_name);
  const units = await loadUnits();

  // No menge filter: many receipt lines have no quantity — the estimator counts
  // those as one piece (for count/blank units) and skips them for mass/volume.
  interface PLine { canonical_name: string; menge: string | null; einheit: string | null; datum: string }
  const lines = (await sql`
    SELECT a.canonical_name, a.menge, a.einheit, e.datum::text AS datum
    FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
    WHERE a.canonical_name IN ${sql(canons)}
      ${kontoScope(user, sql`e.konto_id`)}
  `) as unknown as PLine[];
  const byCanon = new Map<string, PLine[]>();
  for (const l of lines) { const arr = byCanon.get(l.canonical_name) ?? []; arr.push(l); byCanon.set(l.canonical_name, arr); }

  const ov = await sql`
    SELECT canonical_name, menge::float8 AS menge, gesetzt_am::text AS gesetzt_am
    FROM vorrat_override WHERE canonical_name IN ${sql(canons)}`;
  const ovMap = new Map(ov.map(o => [o.canonical_name as string, { menge: o.menge as number, gesetzt_am: o.gesetzt_am as string }]));

  const res = await sql`
    SELECT canonical_name, COALESCE(SUM(menge), 0)::float8 AS total, COUNT(*)::int AS charges
    FROM reserve_charge WHERE canonical_name IN ${sql(canons)} GROUP BY canonical_name`;
  const resMap = new Map(res.map(r => [r.canonical_name as string, { total: r.total as number, charges: r.charges as number }]));

  return tracked.map(tk => {
    const est = estimateVorrat(byCanon.get(tk.canonical_name) ?? [], tk.base_unit, units, ovMap.get(tk.canonical_name) ?? null);
    const reserve = resMap.get(tk.canonical_name);
    return {
      canonical_name: tk.canonical_name,
      ...est,
      reserve_min: tk.reserve_min,
      reserve_total: reserve?.total ?? 0,
      reserve_charges: reserve?.charges ?? 0,
      vorrat_sort: tk.vorrat_sort,
    };
  }).sort((a, b) =>
    ((b.vorrat_sort ?? -Infinity) - (a.vorrat_sort ?? -Infinity)) ||
    ((a.days_until_empty ?? 1e9) - (b.days_until_empty ?? 1e9)));
}

export function pantryRoutes(app: FastifyInstance): void {
  /** Live stock estimate for the products opted into tracking (track_vorrat). */
  app.get('/api/pantry', async (req) => trackedVorrat(req.user));

  /** Manual "we actually have N" override — becomes the estimate's anchor. */
  app.put('/api/pantry/:name/override', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const { menge } = (req.body ?? {}) as { menge?: number };
    if (menge == null || !Number.isFinite(menge)) return reply.code(400).send({ error: 'menge required' });
    await sql`
      INSERT INTO vorrat_override (canonical_name, menge, gesetzt_am)
      VALUES (${name}, ${menge}, NOW())
      ON CONFLICT (canonical_name) DO UPDATE SET menge = EXCLUDED.menge, gesetzt_am = NOW()`;
    return { ok: true };
  });
  app.delete('/api/pantry/:name/override', async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    await sql`DELETE FROM vorrat_override WHERE canonical_name = ${name}`;
    return { ok: true };
  });

  /** Persist a manual drag order for the Vorrat list (first = top). */
  app.put('/api/pantry/order', async (req, reply) => {
    const { order } = (req.body ?? {}) as { order?: string[] };
    if (!Array.isArray(order)) return reply.code(400).send({ error: 'order array required' });
    await sql.begin(async tx => {
      for (let i = 0; i < order.length; i++) {
        await tx`UPDATE canonical_meta SET vorrat_sort = ${order.length - i} WHERE canonical_name = ${order[i]}`;
      }
    });
    return { ok: true };
  });

  /** Iron-reserve charges (batches with their own expiry) for a product. */
  app.get('/api/reserve/:name', async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    return sql`
      SELECT id, gekauft_am::text AS gekauft_am, ablauf_am::text AS ablauf_am,
             menge::float8 AS menge, einheit, notiz
      FROM reserve_charge WHERE canonical_name = ${name}
      ORDER BY ablauf_am ASC NULLS LAST, id`;
  });
  app.post('/api/reserve', async (req, reply) => {
    const b = (req.body ?? {}) as { canonical_name?: string; gekauft_am?: string | null; ablauf_am?: string | null; menge?: number | null; einheit?: string | null; notiz?: string | null };
    const name = b.canonical_name?.trim();
    if (!name) return reply.code(400).send({ error: 'canonical_name required' });
    await sql`
      INSERT INTO reserve_charge (canonical_name, gekauft_am, ablauf_am, menge, einheit, notiz)
      VALUES (${name}, ${b.gekauft_am || null}, ${b.ablauf_am || null}, ${b.menge ?? null}, ${b.einheit || null}, ${b.notiz || null})`;
    return { ok: true };
  });
  app.delete('/api/reserve/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'id required' });
    await sql`DELETE FROM reserve_charge WHERE id = ${id}`;
    return { ok: true };
  });

  /** The shopping list (rich): per entry a title, optional quantity, the
   *  household's average price for the linked product, and the resulting
   *  expected price. Free-text entries (canonical_name NULL) carry no price. */
  app.get('/api/shopping-list', async (req) => {
    const items = await sql`
      SELECT id, canonical_name, title, menge::float8 AS menge, einheit, source, done, priority, added_by, added_at
      FROM einkaufsliste_item
      ORDER BY done ASC, priority DESC, added_at DESC
    `;
    const canons = [...new Set(items.map(i => i.canonical_name as string | null).filter((c): c is string => !!c))];

    const units = await loadUnits();
    const avgByCanon = new Map<string, { price: number; unit: string }>();
    const vorratByCanon = new Map<string, { days_until_empty: number | null; est_remaining: number | null }>();

    if (canons.length) {
      interface Line { canonical_name: string; preis: string | null; menge: string | null; einheit: string | null }
      const lines = await sql`
        SELECT a.canonical_name, a.preis, a.menge, a.einheit
        FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
        WHERE a.canonical_name IN ${sql(canons)} AND a.preis IS NOT NULL ${kontoScope(req.user, sql`e.konto_id`)}
      `;
      const metaRows = await sql`SELECT canonical_name, base_unit FROM canonical_meta WHERE canonical_name IN ${sql(canons)}`;
      const baseUnit = new Map(metaRows.map(m => [m.canonical_name as string, (m.base_unit as string | null) ?? null]));
      const byCanon = new Map<string, Line[]>();
      for (const l of lines as unknown as Line[]) {
        const arr = byCanon.get(l.canonical_name) ?? [];
        arr.push(l); byCanon.set(l.canonical_name, arr);
      }
      for (const c of canons) {
        const groups = comparisonGroups((byCanon.get(c) ?? []) as unknown as PriceLine[], units);
        const buKey = unitKey(units, baseUnit.get(c) ?? undefined);
        const g = (buKey ? groups.find(x => x.unit === buKey) : undefined) ?? groups[0];
        if (g && g.avg > 0) avgByCanon.set(c, { price: g.avg, unit: g.unit });
      }
      const vs = await sql`
        SELECT canonical_name, days_until_empty::float8 AS days_until_empty, est_remaining::float8 AS est_remaining
        FROM vorrat_status WHERE canonical_name IN ${sql(canons)}
      `;
      for (const r of vs) vorratByCanon.set(r.canonical_name as string, {
        days_until_empty: r.days_until_empty as number | null, est_remaining: r.est_remaining as number | null,
      });
    }

    return items.map(it => {
      const cn = it.canonical_name as string | null;
      const avg = cn ? avgByCanon.get(cn) : undefined;
      // menge is in the product's base unit; default one package (1) when unset.
      const menge = (it.menge as number | null) ?? 1;
      const expected = avg ? Math.round(menge * avg.price * 100) / 100 : null;
      const vrt = cn ? vorratByCanon.get(cn) : undefined;
      return {
        ...it,
        avg_price: avg ? Math.round(avg.price * 100) / 100 : null,
        avg_unit: avg?.unit ?? null,
        expected_price: expected,
        days_until_empty: vrt?.days_until_empty ?? null,
        est_remaining: vrt?.est_remaining ?? null,
      };
    });
  });

  /** Add to the list. canonical_name → a known product (deduped); otherwise a
   *  free-text entry (title required). Optional menge/einheit. */
  app.post('/api/shopping-list', async (req, reply) => {
    const b = (req.body ?? {}) as { canonical_name?: string; title?: string; menge?: number | null; einheit?: string | null };
    const canonical = b.canonical_name?.trim() || null;
    const title = (b.title?.trim() || canonical) ?? null;
    if (!title) return reply.code(400).send({ error: 'title or canonical_name required' });
    const prio = sql`(SELECT COALESCE(MAX(priority), 0) + 1 FROM einkaufsliste_item)`; // new items to the top
    if (canonical) {
      await sql`
        INSERT INTO einkaufsliste_item (canonical_name, title, menge, einheit, added_by, priority)
        VALUES (${canonical}, ${title}, ${b.menge ?? 1}, ${b.einheit ?? null}, ${req.user!.username}, ${prio})
        ON CONFLICT (canonical_name) WHERE canonical_name IS NOT NULL DO NOTHING
      `;
    } else {
      await sql`
        INSERT INTO einkaufsliste_item (canonical_name, title, menge, einheit, added_by, priority)
        VALUES (NULL, ${title}, ${b.menge ?? 1}, ${b.einheit ?? null}, ${req.user!.username}, ${prio})
      `;
    }
    return { ok: true };
  });

  /** Edit an entry (menge/einheit/title/done/priority). null/absent = unchanged. */
  app.patch('/api/shopping-list/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'id required' });
    const b = (req.body ?? {}) as { title?: string; menge?: number | null; einheit?: string | null; done?: boolean; priority?: number };
    await sql`
      UPDATE einkaufsliste_item SET
        title    = COALESCE(${b.title ?? null}::text, title),
        menge    = COALESCE(${b.menge ?? 1}::numeric, menge),
        einheit  = COALESCE(${b.einheit ?? null}::text, einheit),
        done     = COALESCE(${b.done ?? null}::boolean, done),
        priority = COALESCE(${b.priority ?? null}::int, priority)
      WHERE id = ${id}
    `;
    return { ok: true };
  });

  app.delete('/api/shopping-list/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'id required' });
    await sql`DELETE FROM einkaufsliste_item WHERE id = ${id}`;
    return { ok: true };
  });

  /** Persist a manual drag order (first id = top → highest priority). */
  app.put('/api/shopping-list/order', async (req, reply) => {
    const { order } = (req.body ?? {}) as { order?: number[] };
    if (!Array.isArray(order) || !order.every(n => Number.isInteger(n))) {
      return reply.code(400).send({ error: 'order array of ids required' });
    }
    await sql.begin(async tx => {
      for (let i = 0; i < order.length; i++) {
        await tx`UPDATE einkaufsliste_item SET priority = ${order.length - i} WHERE id = ${order[i]}`;
      }
    });
    return { ok: true };
  });

  /** Auto-fill the list from tracked products whose live estimate is running low
   *  (out / ≤5 days / below the iron-reserve minimum), skipping anything already
   *  on the list, snoozed, or excluded. Adds them as 'suggested'. */
  app.post('/api/shopping-list/suggest', async (req) => {
    const all = await trackedVorrat(req.user);
    const due = all.filter(p =>
      (p.est_remaining != null && p.est_remaining <= 0) ||
      (p.days_until_empty != null && p.days_until_empty <= 5) ||
      (p.reserve_min != null && p.est_remaining != null && p.est_remaining <= p.reserve_min));
    if (!due.length) return { ok: true, added: 0 };

    const onList = new Set((await sql`SELECT canonical_name FROM einkaufsliste_item WHERE canonical_name IS NOT NULL`).map(r => r.canonical_name as string));
    const snoozed = new Set((await sql`SELECT canonical_name FROM vorschlag_snooze WHERE snooze_bis > CURRENT_DATE`).map(r => r.canonical_name as string));
    const excluded = new Set((await sql`SELECT canonical_name FROM artikel_ausschluss`).map(r => r.canonical_name as string));
    const toAdd = due.filter(p => !onList.has(p.canonical_name) && !snoozed.has(p.canonical_name) && !excluded.has(p.canonical_name));
    if (!toAdd.length) return { ok: true, added: 0 };

    await sql.begin(async tx => {
      for (const p of toAdd) {
        await tx`
          INSERT INTO einkaufsliste_item (canonical_name, title, menge, source, priority, added_by)
          VALUES (${p.canonical_name}, ${p.canonical_name}, 1, 'suggested',
                  (SELECT COALESCE(MAX(priority), 0) + 1 FROM einkaufsliste_item), ${req.user!.username})
          ON CONFLICT (canonical_name) WHERE canonical_name IS NOT NULL DO NOTHING`;
      }
    });
    return { ok: true, added: toAdd.length };
  });

  /** Register the list's products as offer "watches" so the next refresh fetches
   *  offers for them (the frontend then POSTs /api/offers/refresh + polls). */
  app.post('/api/shopping-list/compare', async (req) => {
    const rows = await sql`SELECT canonical_name, title FROM einkaufsliste_item`;
    const names = [...new Set(rows.map(r => (r.canonical_name as string | null) ?? (r.title as string)).filter(Boolean))];
    if (names.length) {
      await sql.begin(async tx => {
        for (const n of names) {
          await tx`INSERT INTO offer_subscription (user_id, kind, ref) VALUES (${req.user!.id}, 'watch', ${n}) ON CONFLICT (user_id, kind, ref) DO NOTHING`;
        }
      });
    }
    return { ok: true, watched: names.length };
  });

  /** Per-chain shopping lists. For each visited chain: the list items that chain
   *  carries (purchase history OR a current offer — so no "bread at a pharmacy"),
   *  ordered by the chain's category order (warengruppen tiers → else global
   *  sort_order), priced offer → chain-average → global-average. */
  app.get('/api/shopping-list/by-store', async (req) => {
    const items = (await sql`
      SELECT id, canonical_name, title, menge::float8 AS menge
      FROM einkaufsliste_item ORDER BY priority DESC, added_at DESC
    `) as unknown as { id: number; canonical_name: string | null; title: string; menge: number | null }[];
    if (!items.length) return { chains: [] };
    const canons = [...new Set(items.map(i => i.canonical_name).filter((c): c is string => !!c))];
    const offerKeys = [...new Set([...canons, ...items.filter(i => !i.canonical_name).map(i => i.title)])];

    const units = await loadUnits();
    const keyFor = (n: string | null | undefined): string | null => {
      if (!n) return null; const u = units.get(n);
      return u ? (u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name) : null;
    };

    const catRows = canons.length ? await sql`
      SELECT canonical_name, mode() WITHIN GROUP (ORDER BY category_path) AS cat
      FROM artikel WHERE canonical_name IN ${sql(canons)} GROUP BY canonical_name` : [];
    const catMap = new Map(catRows.map(r => [r.canonical_name as string, (r.cat as string | null) ?? null]));
    const buRows = canons.length ? await sql`SELECT canonical_name, base_unit FROM canonical_meta WHERE canonical_name IN ${sql(canons)}` : [];
    const buMap = new Map(buRows.map(r => [r.canonical_name as string, (r.base_unit as string | null) ?? null]));

    interface Line { canonical_name: string; preis: string | null; menge: string | null; einheit: string | null; store: string }
    const lines = canons.length ? (await sql`
      SELECT a.canonical_name, a.preis, a.menge, a.einheit, e.roh_ladenname AS store
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.canonical_name IN ${sql(canons)} AND a.preis IS NOT NULL AND a.preis > 0
        ${kontoScope(req.user, sql`e.konto_id`)}`) as unknown as Line[] : [];
    const allByCanon = new Map<string, PriceLine[]>();
    const byCanonChain = new Map<string, PriceLine[]>();
    const carried = new Set<string>();
    const push = (m: Map<string, PriceLine[]>, k: string, v: PriceLine) => { let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(v); };
    for (const l of lines) {
      push(allByCanon, l.canonical_name, l as unknown as PriceLine);
      const chain = normalizeStore(l.store);
      if (!chain) continue;
      const k = `${l.canonical_name} ${chain}`;
      push(byCanonChain, k, l as unknown as PriceLine);
      carried.add(k);
    }
    const resolved = new Map<string, { unit: string; globalAvg: number }>();
    for (const c of canons) {
      const groups = comparisonGroups(allByCanon.get(c) ?? [], units);
      const h = (keyFor(buMap.get(c)) ? groups.find(g => g.unit === keyFor(buMap.get(c))) : undefined) ?? groups[0];
      if (h && h.avg > 0) resolved.set(c, { unit: h.unit, globalAvg: h.avg });
    }
    const chainAvg = (canon: string, chain: string): number | null => {
      const r = resolved.get(canon); if (!r) return null;
      const g = comparisonGroups(byCanonChain.get(`${canon} ${chain}`) ?? [], units).find(x => x.unit === r.unit);
      return g && g.avg > 0 ? g.avg : null;
    };

    const offRows = offerKeys.length ? await sql`
      SELECT canonical_name, chain_slug, ref_price, price, unit FROM offer
      WHERE canonical_name IN ${sql(offerKeys)} AND chain_slug IS NOT NULL AND found_at > NOW() - INTERVAL '21 days'` : [];
    const offerMap = new Map<string, { grundpreis: number; unit: string }>();
    for (const o of offRows) {
      const un = normalizeEinheit(o.unit as string | null);
      const u = un ? units.get(un) : undefined;
      const raw = o.ref_price != null ? Number(o.ref_price) : parsePrice(o.price as string | null);
      if (raw == null || !Number.isFinite(raw)) continue;
      const ogroup = u ? (u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name) : null;
      if (!ogroup) continue;
      const grundpreis = Math.round((u ? raw / u.to_base : raw) * 100) / 100;
      const k = `${o.canonical_name} ${o.chain_slug}`;
      const cur = offerMap.get(k);
      if (!cur || grundpreis < cur.grundpreis) offerMap.set(k, { grundpreis, unit: ogroup });
    }

    const chainRows = await sql`
      SELECT f.chain_key, MAX(f.name) AS name,
             (array_agg(f.warengruppen) FILTER (WHERE f.warengruppen IS NOT NULL))[1] AS warengruppen
      FROM store_branch f LEFT JOIN einkauf e ON e.branch_id = f.id ${kontoScope(req.user, sql`e.konto_id`)}
      WHERE f.kind = 'filiale'
      GROUP BY f.chain_key HAVING COUNT(e.id) > 0 ORDER BY COUNT(e.id) DESC`;
    const sortOrder = new Map((await sql`SELECT path, sort_order FROM category`).map(r => [r.path as string, r.sort_order as number]));
    const tierIndex = (wg: string[][] | null, cat: string | null): number | null => {
      if (!wg || !cat) return null;
      let best: number | null = null; let bestLen = -1;
      wg.forEach((tier, i) => { for (const path of tier) if ((cat === path || cat.startsWith(path + '/')) && path.length > bestLen) { best = i; bestLen = path.length; } });
      return best;
    };

    const chains = [];
    for (const ch of chainRows) {
      const chainKey = ch.chain_key as string;
      const wg = ch.warengruppen ? (typeof ch.warengruppen === 'string' ? JSON.parse(ch.warengruppen) : ch.warengruppen) as string[][] : null;
      const out: { id: number; canonical_name: string | null; title: string; menge: number; category: string | null; price: number | null; unit: string | null; source: string | null; expected: number | null; _sort: number }[] = [];
      for (const it of items) {
        const menge = it.menge ?? 1;
        let price: number | null = null, unit: string | null = null, source: string | null = null, cat: string | null = null, include = false;
        if (it.canonical_name) {
          cat = catMap.get(it.canonical_name) ?? null;
          const r = resolved.get(it.canonical_name);
          unit = r?.unit ?? null;
          const off = offerMap.get(`${it.canonical_name} ${chainKey}`);
          const hasHistory = carried.has(`${it.canonical_name} ${chainKey}`);
          if (!hasHistory && !off) continue; // chain doesn't carry it
          if (off && (!unit || off.unit === unit)) { price = off.grundpreis; unit = off.unit; source = 'offer'; }
          else {
            const ca = chainAvg(it.canonical_name, chainKey);
            if (ca != null) { price = ca; source = 'store_avg'; }
            else if (r) { price = r.globalAvg; source = 'global_avg'; }
            else if (off) { price = off.grundpreis; unit = off.unit; source = 'offer'; }
          }
          include = true;
        } else {
          const off = offerMap.get(`${it.title} ${chainKey}`);
          if (off) { price = off.grundpreis; unit = off.unit; source = 'offer'; }
          include = true; // free-text: buy it somewhere
        }
        if (!include) continue;
        const ti = tierIndex(wg, cat);
        const _sort = ti != null ? ti : (cat != null && sortOrder.has(cat) ? 1000 + (sortOrder.get(cat) ?? 0) : 1e6);
        out.push({ id: it.id, canonical_name: it.canonical_name, title: it.title, menge, category: cat, price, unit, source, expected: price != null ? Math.round(menge * price * 100) / 100 : null, _sort });
      }
      if (!out.length) continue;
      out.sort((a, b) => a._sort - b._sort);
      const total = Math.round(out.reduce((s, x) => s + (x.expected ?? 0), 0) * 100) / 100;
      chains.push({ chain_key: chainKey, store: ch.name as string, item_count: out.length, total, items: out.map(({ _sort, ...x }) => x) });
    }
    chains.sort((a, b) => b.item_count - a.item_count || a.total - b.total);
    return { chains };
  });

  /** Canonical-keyed feedback (used by the offers "on list" toggle). */
  app.post('/api/shopping-list/feedback', async (req, reply) => {
    const { action, canonical_name, snooze_days } = (req.body ?? {}) as {
      action?: string; canonical_name?: string; snooze_days?: number;
    };
    if (!action || !canonical_name) return reply.code(400).send({ error: 'action and canonical_name required' });

    if (action === 'done') {
      await sql`DELETE FROM einkaufsliste_item WHERE canonical_name = ${canonical_name}`;
    } else if (action === 'snooze') {
      const days = snooze_days ?? 7;
      await sql.begin(async tx => {
        await tx`
          INSERT INTO vorschlag_snooze (canonical_name, snooze_bis)
          VALUES (${canonical_name}, CURRENT_DATE + ${days})
          ON CONFLICT (canonical_name) DO UPDATE SET snooze_bis = EXCLUDED.snooze_bis
        `;
        await tx`DELETE FROM einkaufsliste_item WHERE canonical_name = ${canonical_name}`;
      });
    } else if (action === 'exclude') {
      await sql.begin(async tx => {
        await tx`INSERT INTO artikel_ausschluss (canonical_name) VALUES (${canonical_name}) ON CONFLICT DO NOTHING`;
        await tx`DELETE FROM einkaufsliste_item WHERE canonical_name = ${canonical_name}`;
      });
    } else {
      return reply.code(400).send({ error: 'unknown action' });
    }
    return { ok: true };
  });

  app.get('/api/alerts', async (req) => {
    const all = await trackedVorrat(req.user);
    return all.filter(p =>
      (p.days_until_empty != null && p.days_until_empty <= 3) ||
      (p.est_remaining != null && p.est_remaining <= 0) ||
      (p.reserve_min != null && p.est_remaining != null && p.est_remaining <= p.reserve_min));
  });
}
