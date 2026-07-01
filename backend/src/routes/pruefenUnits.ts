import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { loadUnits, normalizeEinheit } from '../lib/units.js';
import { recommendUnit } from '../lib/unitRecommend.js';

/**
 * Unit-review — the second half of the Prüfung page.
 *
 * Where name-review confirms WHAT a product is, unit-review confirms the UNIT it's
 * priced/tracked in (its Grundpreis-Einheit). VDS derives a recommendation per
 * canonical product from its purchase history — a *variable* weight means loose
 * weighing → kg, a *constant* pack size means a fixed package → Stück, a drink →
 * Flasche/Dose (see lib/unitRecommend.ts). We surface only the products whose
 * recommendation DIFFERS from the stored base_unit and that haven't been reviewed
 * yet. Applying or keeping stamps base_unit_confirmed_at so the row never nags again.
 *
 * This is per-CANONICAL (a product), not per-OCR-line like name-review. Applying
 * also auto-fills expected_price (median €/unit) when none is set, so the shopping
 * list immediately has a sensible not-carried price. It never overwrites a manual
 * expected_price.
 */

type User = Parameters<typeof kontoScope>[0];
type Units = Awaited<ReturnType<typeof loadUnits>>;

const MIN_OCCUR = 3;   // need a few purchases before a unit recommendation is trustworthy
const toNum = (v: unknown): number => {
  if (v == null) return NaN;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

interface Line { preis: string | number | null; menge: string | number | null; einheit: string | null }

export interface UnitReviewRow {
  canonical_name: string;
  current_unit: string | null;
  suggested_unit: string;
  kind: string;
  confidence: string;            // formatted "0.90" so the shared confColor() reads it
  rationale: string;
  occurrences: number;
  current_price: number | null;  // existing expected_price (€/base-unit)
  suggested_price: number | null; // auto median, only offered when current_price is null
}

/** Median €/suggested-unit from the purchase lines. For a mass/volume suggestion this
 *  is €/kg or €/l over lines actually recorded in that dimension. For a count unit each
 *  line is N pieces (its Menge if in a count unit) else one whole pack — so a fixed-pack
 *  line (160 g @ 2.49) yields €2.49/Stück. The one exception: if the product ALSO has
 *  genuine count-unit lines, a mass/volume line is a loose weighed purchase (not a pack)
 *  and is skipped, so its total price can't be misread as a per-piece price. Returns null
 *  if nothing usable. */
function medianUnitPrice(lines: Line[], suggestedUnit: string, units: Units): number | null {
  const su = units.get(suggestedUnit);
  const dim = su?.dimension ?? 'count';
  const hasCountLines = dim === 'count' && lines.some(l => {
    const un = normalizeEinheit(l.einheit);
    return un ? units.get(un)?.dimension === 'count' : false;
  });
  const prices: number[] = [];
  for (const l of lines) {
    const p = toNum(l.preis);
    if (!(p > 0)) continue;
    const un = normalizeEinheit(l.einheit);
    const u = un ? units.get(un) : undefined;
    if (dim === 'mass' || dim === 'volume') {
      if (u && u.dimension === dim) {
        const q = toNum(l.menge) * u.to_base;
        if (q > 0) prices.push(p / q);
      }
    } else {
      // Mass/volume line = one whole pack (its total price) for a pure fixed-pack product;
      // but if real count lines exist, treat it as a loose weighed purchase and skip it.
      if (u && u.dimension !== 'count' && hasCountLines) continue;
      const cnt = u && u.dimension === 'count' && toNum(l.menge) > 0 ? toNum(l.menge) : 1;
      prices.push(p / cnt);
    }
  }
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const m = prices[Math.floor(prices.length / 2)];
  return Math.round(m * 100) / 100;
}

/** Build the review list: run the recommender over every visible canonical product and
 *  keep the ones whose suggestion disagrees with the stored (or missing) base_unit and
 *  that the user hasn't reviewed. Konto-scoped like the rest of Prüfen. */
async function buildUnitReviewRows(user: User): Promise<UnitReviewRow[]> {
  const units = await loadUnits();
  const lineRows = (await sql`
    SELECT a.canonical_name, a.preis, a.menge, a.einheit
    FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
    WHERE a.canonical_name IS NOT NULL ${kontoScope(user, sql`e`)}
  `) as unknown as ({ canonical_name: string } & Line)[];
  const catRows = await sql`
    SELECT a.canonical_name, mode() WITHIN GROUP (ORDER BY a.category_path) AS cat
    FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
    WHERE a.canonical_name IS NOT NULL ${kontoScope(user, sql`e`)}
    GROUP BY a.canonical_name`;
  const metaRows = await sql`
    SELECT canonical_name, base_unit, hidden,
           expected_price::float8 AS expected_price, base_unit_confirmed_at
    FROM canonical_meta`;

  const linesByCanon = new Map<string, Line[]>();
  for (const l of lineRows) {
    const arr = linesByCanon.get(l.canonical_name) ?? [];
    arr.push(l);
    linesByCanon.set(l.canonical_name, arr);
  }
  const catMap = new Map(catRows.map(r => [r.canonical_name as string, (r.cat as string | null) ?? null]));
  const metaMap = new Map(metaRows.map(r => [r.canonical_name as string, r]));

  const rows: UnitReviewRow[] = [];
  for (const [name, lines] of linesByCanon) {
    if (lines.length < MIN_OCCUR) continue;
    const meta = metaMap.get(name);
    if (meta?.hidden) continue;                       // hidden products aren't worth reviewing
    if (meta?.base_unit_confirmed_at) continue;       // already reviewed → don't nag
    const current = (meta?.base_unit as string | null) ?? null;
    const reco = recommendUnit(lines, catMap.get(name) ?? null, units);
    if (reco.unit === current) continue;              // recommendation already matches → nothing to do
    const currentPrice = (meta?.expected_price as number | null) ?? null;
    rows.push({
      canonical_name: name,
      current_unit: current,
      suggested_unit: reco.unit,
      kind: reco.kind,
      confidence: reco.confidence.toFixed(2),
      rationale: reco.rationale,
      occurrences: lines.length,
      current_price: currentPrice,
      // The €/unit that applying will set (apply always refreshes the price for the new
      // unit — see applyUnit), so the user sees exactly what will be stored.
      suggested_price: medianUnitPrice(lines, reco.unit, units),
    });
  }
  rows.sort((a, b) => parseFloat(b.confidence) - parseFloat(a.confidence) || b.occurrences - a.occurrences);
  return rows.slice(0, 200);
}

/** Apply a chosen unit to a product: set base_unit, refresh expected_price for that unit,
 *  and stamp it reviewed. expected_price means €/base_unit, so it is coupled to the unit —
 *  when the unit changes we recompute the median €/new-unit (else a €/Stück figure would be
 *  silently misread as €/kg). The median may be null (nothing usable) → store NULL and let
 *  comparisonGroups re-derive the €/base-unit headline. Konto-scoped price. */
async function applyUnit(user: User, name: string, unit: string): Promise<void> {
  const units = await loadUnits();
  const lines = (await sql`
    SELECT a.preis, a.menge, a.einheit
    FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
    WHERE a.canonical_name = ${name} ${kontoScope(user, sql`e`)}
  `) as unknown as Line[];
  const price = medianUnitPrice(lines, unit, units);
  await sql`
    INSERT INTO canonical_meta (canonical_name, base_unit, expected_price, base_unit_confirmed_at, updated_at, updated_by)
    VALUES (${name}, ${unit}, ${price}, NOW(), NOW(), ${user?.id ?? null})
    ON CONFLICT (canonical_name) DO UPDATE SET
      base_unit = EXCLUDED.base_unit, expected_price = EXCLUDED.expected_price,
      base_unit_confirmed_at = NOW(), updated_at = NOW(), updated_by = EXCLUDED.updated_by`;
}

/** Keep the current unit but mark the product reviewed (stops it re-appearing). */
async function keepUnit(user: User, name: string): Promise<void> {
  await sql`
    INSERT INTO canonical_meta (canonical_name, base_unit_confirmed_at, updated_at, updated_by)
    VALUES (${name}, NOW(), NOW(), ${user?.id ?? null})
    ON CONFLICT (canonical_name) DO UPDATE SET
      base_unit_confirmed_at = NOW(), updated_at = NOW(), updated_by = EXCLUDED.updated_by`;
}

export function pruefenUnitRoutes(app: FastifyInstance): void {
  app.get('/api/pruefen-units', async (req) => {
    const items = await buildUnitReviewRows(req.user);
    return { items, total: items.length };
  });

  app.post('/api/pruefen-units/decide', async (req, reply) => {
    const { name, unit, action } = (req.body ?? {}) as { name?: string; unit?: string; action?: string };
    const nm = (name ?? '').trim();
    if (!nm || !action) return reply.code(400).send({ error: 'name and action required' });
    if (action === 'apply') {
      const u = (unit ?? '').trim();
      if (!u) return reply.code(400).send({ error: 'unit required' });
      await applyUnit(req.user, nm, u);
      return { ok: true };
    }
    if (action === 'keep') {
      await keepUnit(req.user, nm);
      return { ok: true };
    }
    return reply.code(400).send({ error: 'bad action' });
  });

  app.post('/api/pruefen-units/decide-bulk', async (req, reply) => {
    const { action, items } = (req.body ?? {}) as { action?: string; items?: { name?: string; unit?: string }[] };
    if (!action || !Array.isArray(items) || !items.length) return reply.code(400).send({ error: 'action and items required' });
    let count = 0;
    if (action === 'apply') {
      for (const it of items) {
        const nm = (it.name ?? '').trim();
        const u = (it.unit ?? '').trim();
        if (!nm || !u) continue;
        await applyUnit(req.user, nm, u);
        count++;
      }
    } else if (action === 'keep') {
      for (const it of items) {
        const nm = (it.name ?? '').trim();
        if (!nm) continue;
        await keepUnit(req.user, nm);
        count++;
      }
    } else {
      return reply.code(400).send({ error: 'bad action' });
    }
    return { ok: true, count };
  });
}
