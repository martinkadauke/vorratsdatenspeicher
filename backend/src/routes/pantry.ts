import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { loadUnits, normalizeEinheit, comparisonGroups, type PriceLine } from '../lib/units.js';

type Units = Awaited<ReturnType<typeof loadUnits>>;

/** Comparison-group key for a unit name: mass→kg, volume→l, count→itself. */
function unitKey(units: Units, name: string | null | undefined): string | null {
  if (!name) return null;
  const u = units.get(name);
  if (!u) return null;
  return u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name;
}

export function pantryRoutes(app: FastifyInstance): void {
  app.get('/api/pantry', async () => {
    return sql`
      SELECT canonical_name, einheit, avg_daily, last_qty, last_bought,
             est_remaining, days_until_empty, purchase_count, updated_at
      FROM vorrat_status
      ORDER BY days_until_empty ASC NULLS LAST
    `;
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
      const menge = it.menge as number | null;
      let expected: number | null = null;
      if (avg && menge != null) {
        const un = normalizeEinheit(it.einheit as string | null);
        const u = un ? units.get(un) : undefined;
        const itemKey = u ? (u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name) : null;
        if (u && itemKey === avg.unit) expected = Math.round(menge * u.to_base * avg.price * 100) / 100;
        else if (!it.einheit) expected = Math.round(menge * avg.price * 100) / 100; // no unit given → assume per-unit
      }
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
    if (canonical) {
      await sql`
        INSERT INTO einkaufsliste_item (canonical_name, title, menge, einheit, added_by)
        VALUES (${canonical}, ${title}, ${b.menge ?? null}, ${b.einheit ?? null}, ${req.user!.username})
        ON CONFLICT (canonical_name) WHERE canonical_name IS NOT NULL DO NOTHING
      `;
    } else {
      await sql`
        INSERT INTO einkaufsliste_item (canonical_name, title, menge, einheit, added_by)
        VALUES (NULL, ${title}, ${b.menge ?? null}, ${b.einheit ?? null}, ${req.user!.username})
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
        menge    = COALESCE(${b.menge ?? null}::numeric, menge),
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

  app.get('/api/alerts', async () => {
    return sql`
      SELECT canonical_name, einheit, est_remaining, days_until_empty, last_bought
      FROM vorrat_status
      WHERE avg_daily IS NOT NULL
        AND (days_until_empty <= 3 OR est_remaining <= 0)
      ORDER BY days_until_empty ASC NULLS FIRST
      LIMIT 20
    `;
  });
}
