import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { loadUnits, comparisonGroups, type PriceLine } from '../lib/units.js';
import { estimateVorrat } from '../lib/vorrat.js';

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
    SELECT canonical_name, base_unit, reserve_min::float8 AS reserve_min
    FROM canonical_meta WHERE track_vorrat = TRUE
  `).map(r => ({ canonical_name: r.canonical_name as string, base_unit: r.base_unit as string | null, reserve_min: r.reserve_min as number | null }));
  if (!tracked.length) return [];
  const canons = tracked.map(tk => tk.canonical_name);
  const units = await loadUnits();

  interface PLine { canonical_name: string; menge: string | null; einheit: string | null; datum: string }
  const lines = (await sql`
    SELECT a.canonical_name, a.menge, a.einheit, e.datum::text AS datum
    FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
    WHERE a.canonical_name IN ${sql(canons)} AND a.menge IS NOT NULL AND a.menge > 0
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
    };
  }).sort((a, b) => (a.days_until_empty ?? 1e9) - (b.days_until_empty ?? 1e9));
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
