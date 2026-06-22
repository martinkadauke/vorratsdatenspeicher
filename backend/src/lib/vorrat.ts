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
  typ_qty: number | null;         // typical (median) quantity per purchase, base unit
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
  ratePerWeekOverride: number | null = null,
): VorratEstimate {
  // Manual consumption override (per week → per day) wins over the derived rate.
  const manualRate = ratePerWeekOverride != null && ratePerWeekOverride > 0 ? ratePerWeekOverride / 7 : null;
  const buKey = groupKey(units, baseUnitName); // declared base-unit group (may be null)

  const keyOf = (u: ReturnType<typeof units.get>): string =>
    u ? (u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name) : 'Stück';

  // Bucket every purchase line by its OWN comparison unit (kg/l/Stück…), summed
  // per date. Empty/unknown units count as pieces (Stück), like the rest of the app.
  // A line with a unit but no quantity is still a real purchase → count it as ONE
  // unit (a quantity-less receipt line is almost always a single item) rather than
  // dropping it. Dropping it was the bug behind "bought today, still shown overdue":
  // a fresh buy with a blank quantity vanished, so the last-bought anchor never moved.
  // (We default to 1, not the group median — multipacks like a 24-can tuna case would
  // otherwise make every blank line count as a whole case and explode the rate.)
  const groups = new Map<string, Map<string, number>>();
  const groupLines = new Map<string, number>();
  for (const l of lines) {
    const un = normalizeEinheit(l.einheit);
    const u = un ? units.get(un) : undefined;
    const key = keyOf(u);
    const m = toNum(l.menge);
    const eff = Number.isFinite(m) && m > 0 ? m : 1;
    const qty = u ? eff * u.to_base : eff;
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

  const perDate = new Map(groups.get(effKey) ?? new Map<string, number>());

  // Unit reconciliation: the same product is often recorded inconsistently — e.g.
  // "1 kg" buckets one time and "2 Stück" (= 2 buckets) another, or with no unit
  // at all. When the base unit is mass/volume, fold those loose count purchases
  // into it, treating each piece as one typical pack (the median real base-unit
  // purchase). Without this the count purchases land in a separate Stück group and
  // get silently dropped from the rate, badly under-counting consumption.
  if (effKey === 'kg' || effKey === 'l') {
    const baseVals = [...(groups.get(effKey)?.values() ?? [])].sort((a, b) => a - b);
    const packSize = baseVals.length ? baseVals[Math.floor(baseVals.length / 2)] : null;
    if (packSize && packSize > 0) {
      for (const [k, pd] of groups) {
        if (k === 'kg' || k === 'l') continue; // only fold count groups into the mass/volume base
        for (const [d, q] of pd) perDate.set(d, (perDate.get(d) ?? 0) + q * packSize);
      }
    }
  }
  const dates = [...perDate.keys()].sort();
  const n = dates.length;
  const last_bought = n ? dates[n - 1] : null;
  if (!n) {
    const rem0 = override?.menge ?? null;
    const due0 = manualRate && rem0 != null ? Math.round((rem0 / manualRate) * 10) / 10 : null;
    return { base_unit: effKey, rate_per_day: manualRate, est_remaining: rem0, days_until_empty: due0, last_bought: null, typ_qty: null, override };
  }

  const qtys = [...perDate.values()].sort((a, b) => a - b);
  const typ_qty = qtys.length ? Math.round(qtys[Math.floor(qtys.length / 2)] * 100) / 100 : null;

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

  const effRate = manualRate ?? rate; // manual weekly override beats the derived rate
  const daysSince = Math.max(0, (Date.now() - anchorMs) / DAY);
  const est_remaining = Math.round((anchorQty + afterAnchor - (effRate ?? 0) * daysSince) * 100) / 100;
  const days_until_empty = effRate && effRate > 0 ? Math.round((est_remaining / effRate) * 10) / 10 : null;

  return {
    base_unit: effKey,
    rate_per_day: effRate != null ? Math.round(effRate * 1000) / 1000 : null,
    est_remaining,
    days_until_empty,
    last_bought,
    typ_qty,
    override,
  };
}
