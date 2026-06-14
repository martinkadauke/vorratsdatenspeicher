// Live stock estimate from purchase history — the in-app replacement for the
// old externally-fed vorrat_status. Everything is normalized to the product's
// base unit (kg/l/Stück) so quantities recorded in g/ml/etc. line up. The
// consumption rate is the *weighted* long-run rate (Σ consumed / Σ days), not
// the mean of per-interval ratios (which over-weights short gaps).
import { normalizeEinheit, loadUnits } from './units.js';

type Units = Awaited<ReturnType<typeof loadUnits>>;

export interface VorratLine { menge: string | number | null; einheit: string | null; datum: string }
export interface VorratOverride { menge: number; gesetzt_am: string }
export interface VorratEstimate {
  base_unit: string | null;       // display group: kg | l | Stück | …
  rate_per_day: number | null;    // base-unit consumed per day
  est_remaining: number | null;   // base unit; may be < 0 (= overdue)
  days_until_empty: number | null;
  last_bought: string | null;
  override: VorratOverride | null;
}

const DAY = 86_400_000;
const groupKey = (units: Units, name: string | null): string | null => {
  if (!name) return null;
  const u = units.get(name);
  if (!u) return null;
  return u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name;
};
const toNum = (v: string | number | null): number =>
  typeof v === 'number' ? v : parseFloat((v ?? '').toString().replace(',', '.'));

export function estimateVorrat(
  lines: VorratLine[], baseUnitName: string | null, units: Units, override: VorratOverride | null,
): VorratEstimate {
  const buKey = groupKey(units, baseUnitName); // declared base-unit group (may be null)

  // Bucket every purchase line by its OWN comparison unit (kg/l/Stück…), summed
  // per date. Empty/unknown units count as pieces (Stück), like the rest of the app.
  const groups = new Map<string, Map<string, number>>();
  const groupLines = new Map<string, number>();
  for (const l of lines) {
    const un = normalizeEinheit(l.einheit);
    const u = un ? units.get(un) : undefined;
    let key: string;
    let qty: number;
    if (u) {
      key = u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name;
      const m = toNum(l.menge);
      if (!Number.isFinite(m)) continue;
      qty = m * u.to_base;
    } else {
      key = 'Stück';
      const m = toNum(l.menge);
      qty = Number.isFinite(m) ? m : 1;
    }
    if (qty <= 0) continue;
    if (!groups.has(key)) groups.set(key, new Map());
    const pd = groups.get(key)!;
    pd.set(l.datum, (pd.get(l.datum) ?? 0) + qty);
    groupLines.set(key, (groupLines.get(key) ?? 0) + 1);
  }

  // Effective unit: the declared base_unit when we actually bought in it; else
  // the unit we most often bought in (so a base_unit of kg with only per-Stück
  // purchases still shows + counts in Stück); else the declared unit / Stück.
  let effKey = buKey && groups.has(buKey) ? buKey : null;
  if (!effKey && groupLines.size) effKey = [...groupLines.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (!effKey) effKey = buKey ?? 'Stück';

  const perDate = groups.get(effKey) ?? new Map<string, number>();
  const dates = [...perDate.keys()].sort();
  const n = dates.length;
  const last_bought = n ? dates[n - 1] : null;
  if (!n) {
    return { base_unit: effKey, rate_per_day: null, est_remaining: override?.menge ?? null, days_until_empty: null, last_bought: null, override };
  }

  // Weighted rate: everything bought before the last purchase is assumed
  // consumed by the last-purchase date.
  let rate: number | null = null;
  if (n >= 2) {
    const spanDays = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / DAY;
    if (spanDays > 0) {
      let consumed = 0;
      for (let i = 0; i < n - 1; i++) consumed += perDate.get(dates[i])!;
      rate = consumed / spanDays;
    }
  }

  // Anchor: the manual override (if any) else the last purchase. Purchases made
  // after the anchor add to what's on hand.
  const anchorMs = override ? Date.parse(override.gesetzt_am) : Date.parse(dates[n - 1]);
  const anchorQty = override ? override.menge : perDate.get(dates[n - 1])!;
  let afterAnchor = 0;
  for (const d of dates) if (Date.parse(d) > anchorMs) afterAnchor += perDate.get(d)!;

  const daysSince = Math.max(0, (Date.now() - anchorMs) / DAY);
  const est_remaining = Math.round((anchorQty + afterAnchor - (rate ?? 0) * daysSince) * 100) / 100;
  const days_until_empty = rate && rate > 0 ? Math.round((est_remaining / rate) * 10) / 10 : null;

  return {
    base_unit: effKey,
    rate_per_day: rate != null ? Math.round(rate * 1000) / 1000 : null,
    est_remaining,
    days_until_empty,
    last_bought,
    override,
  };
}
