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

export interface MixedUnitRow {
  canonical_name: string;
  histogram: { label: string | null; n: number }[]; // null = blank/no unit (frontend translates); order by n desc
  suggested_unit: string;                           // count unit the normalize action pre-selects
  lines: number;
}

/** Products whose POSITIONS disagree about the unit — the data-quality view the
 *  base-unit review above can't see (it only compares recommendation vs stored
 *  base_unit and goes silent once confirmed). Flagged when the positions mix
 *  more than one COUNT unit name (stk vs Packung) or mix blank/unknown lines
 *  with explicit ones. Mass/volume lines coexisting with count lines are NOT
 *  flagged — that's legitimate recording ("Gouda 400g" next to "1 Stück") and
 *  the Vorrat estimator folds them. Rows disappear by themselves once
 *  normalized (criteria-based, no review flag needed). */
async function buildMixedRows(user: User): Promise<MixedUnitRow[]> {
  const units = await loadUnits();
  const lineRows = (await sql`
    SELECT a.canonical_name, a.einheit
    FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
    WHERE a.canonical_name IS NOT NULL ${kontoScope(user, sql`e`)}
  `) as unknown as { canonical_name: string; einheit: string | null }[];
  const metaRows = await sql`SELECT canonical_name, base_unit, hidden, mixed_accepted_at FROM canonical_meta`;
  const metaMap = new Map(metaRows.map(r => [r.canonical_name as string, r]));

  const byCanon = new Map<string, (string | null)[]>();
  for (const l of lineRows) {
    const arr = byCanon.get(l.canonical_name) ?? [];
    arr.push(l.einheit);
    byCanon.set(l.canonical_name, arr);
  }

  const rows: MixedUnitRow[] = [];
  for (const [name, einheiten] of byCanon) {
    if (einheiten.length < MIN_OCCUR) continue;
    if (metaMap.get(name)?.hidden) continue;
    if (metaMap.get(name)?.mixed_accepted_at) continue;  // user accepted the discrepancy → never nag again
    const hist = new Map<string, number>();          // display label → n
    const countNames = new Set<string>();            // distinct normalized COUNT units
    let blanks = 0, explicit = 0;
    for (const raw of einheiten) {
      const un = normalizeEinheit(raw);
      const u = un ? units.get(un) : undefined;
      const label = u ? u.name : (raw ?? '').trim() ? `"${(raw ?? '').trim()}"` : '(ohne)';
      hist.set(label, (hist.get(label) ?? 0) + 1);
      if (u) {
        explicit++;
        if (u.dimension === 'count') countNames.add(u.name);
      } else {
        blanks++;                                    // blank OR unrecognized → unit-agnostic
      }
    }
    const mixed = countNames.size > 1 || (blanks > 0 && explicit > 0);
    if (!mixed) continue;
    // Pre-select: stored base_unit when it's a count unit, else the most-bought
    // count unit, else Stück.
    const baseUnit = (metaMap.get(name)?.base_unit as string | null) ?? null;
    let suggested = baseUnit && units.get(baseUnit)?.dimension === 'count' ? baseUnit : null;
    if (!suggested && countNames.size) {
      suggested = [...countNames].sort((a, b) => (hist.get(b) ?? 0) - (hist.get(a) ?? 0))[0];
    }
    rows.push({
      canonical_name: name,
      histogram: [...hist.entries()].map(([label, n]) => ({ label: label === '(ohne)' ? null : label, n })).sort((a, b) => b.n - a.n),
      suggested_unit: suggested ?? 'Stück',
      lines: einheiten.length,
    });
  }
  rows.sort((a, b) => b.lines - a.lines);
  return rows.slice(0, 200);
}

/** Normalize a product's positions to ONE count unit — the bulk repair for mixed
 *  recording ("Alle mit diesem Namen" in the article editor never propagated the
 *  unit). SAFE by construction: only blank/unknown lines and lines already in a
 *  COUNT unit are relabelled (their menge is a piece count either way). Mass and
 *  volume lines are NEVER touched — "Gouda 400g" must not become "400 Stück";
 *  the Vorrat estimator folds those. Also sets the product's base_unit (+ median
 *  price, + reviewed stamp) via applyUnit so Grundpreis and positions agree. */
async function normalizeUnits(user: User, name: string, unit: string): Promise<number> {
  const units = await loadUnits();
  const target = units.get(unit);
  if (!target || target.dimension !== 'count') throw new Error('unit must be a count unit');

  const distinct = (await sql`
    SELECT DISTINCT einheit FROM artikel WHERE canonical_name = ${name}
  `) as unknown as { einheit: string | null }[];
  // Raw einheit values safe to relabel: blank/unknown (unit-agnostic) + count units.
  const rewrite: string[] = [];
  let hasNullOrBlank = false;
  for (const d of distinct) {
    const raw = d.einheit;
    if (raw == null || !raw.trim()) { hasNullOrBlank = true; if (raw != null) rewrite.push(raw); continue; }
    const un = normalizeEinheit(raw);
    const u = un ? units.get(un) : undefined;
    // Unknown units are unit-agnostic OCR noise; count units carry a piece count
    // either way. Both are safe to relabel. raw === unit is already a no-op.
    if ((!u || u.dimension === 'count') && raw !== unit) rewrite.push(raw);
  }
  const updated = await sql`
    UPDATE artikel SET einheit = ${unit}
    WHERE canonical_name = ${name}
      AND (${hasNullOrBlank ? sql`einheit IS NULL` : sql`FALSE`}
           OR ${rewrite.length ? sql`einheit IN ${sql(rewrite)}` : sql`FALSE`})
    RETURNING id`;
  await applyUnit(user, name, unit);
  return updated.length;
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
    const [items, mixed] = await Promise.all([buildUnitReviewRows(req.user), buildMixedRows(req.user)]);
    return { items, total: items.length, mixed };
  });

  /** Accept a product's unit discrepancy as-is: hide it from the mixed list for
   *  good WITHOUT touching any position (e.g. Bananen — 46× kg + a few blanks;
   *  normalizing to a count unit would be wrong, the estimator imputes blanks). */
  app.post('/api/pruefen-units/mixed-accept', async (req, reply) => {
    const nm = (((req.body ?? {}) as { name?: string }).name ?? '').trim();
    if (!nm) return reply.code(400).send({ error: 'name required' });
    await sql`
      INSERT INTO canonical_meta (canonical_name, mixed_accepted_at, updated_at, updated_by)
      VALUES (${nm}, NOW(), NOW(), ${req.user?.id ?? null})
      ON CONFLICT (canonical_name) DO UPDATE SET
        mixed_accepted_at = NOW(), updated_at = NOW(), updated_by = EXCLUDED.updated_by`;
    return { ok: true };
  });

  /** Normalize all safely-relabelable positions of a product to ONE count unit
   *  (+ base_unit/price/reviewed via applyUnit). Mass/volume lines untouched. */
  app.post('/api/pruefen-units/normalize', async (req, reply) => {
    const { name, unit } = (req.body ?? {}) as { name?: string; unit?: string };
    const nm = (name ?? '').trim();
    const u = (unit ?? '').trim();
    if (!nm || !u) return reply.code(400).send({ error: 'name and unit required' });
    try {
      const updated = await normalizeUnits(req.user, nm, u);
      return { ok: true, updated };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
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
