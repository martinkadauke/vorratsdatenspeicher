// Live stock estimate from purchase history — the in-app replacement for the
// old externally-fed vorrat_status. Everything is normalized to the product's
// base unit (kg/l/Stück) so quantities recorded in g/ml/etc. line up. The
// consumption rate is the *weighted* long-run rate (Σ consumed / Σ days), not
// the mean of per-interval ratios (which over-weights short gaps).
import { normalizeEinheit, loadUnits } from './units.js';

type Units = Awaited<ReturnType<typeof loadUnits>>;

export interface VorratLine { menge: string | number | null; einheit: string | null; datum: string; preis?: string | number | null }
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
// One comparison group per DIMENSION: kg (mass), l (volume), Stück (count).
// All count units (Stück, Packung, Dose, Flasche, …) are the SAME group — they
// all mean "one thing bought". Treating each count NAME as its own group made a
// base_unit of "Packung" match only the receipts that literally printed
// "Packung" and silently drop every "stk"/blank purchase (the Kaffeepulver bug:
// 2 ancient Packung lines won, 15 newer stk/g/blank purchases vanished).
const groupKey = (units: Units, name: string | null): string | null => {
  if (!name) return null;
  const u = units.get(name);
  if (!u) return null;
  return u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : 'Stück';
};
const toNum = (v: string | number | null): number =>
  typeof v === 'number' ? v : parseFloat((v ?? '').toString().replace(',', '.'));

export function estimateVorrat(
  lines: VorratLine[], baseUnitName: string | null, units: Units, override: VorratOverride | null,
  ratePerWeekOverride: number | null = null, expectedUnitPrice: number | null = null,
): VorratEstimate {
  // Manual consumption override (per week → per day) wins over the derived rate.
  const manualRate = ratePerWeekOverride != null && ratePerWeekOverride > 0 ? ratePerWeekOverride / 7 : null;
  const buKey = groupKey(units, baseUnitName); // declared base-unit group (may be null)

  const keyOf = (u: ReturnType<typeof units.get>): string =>
    u ? (u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : 'Stück') : 'Stück';

  // Bucket every purchase line by its OWN comparison unit (kg/l/Stück…), summed
  // per date. Empty/unknown units count as pieces (Stück), like the rest of the app.
  // A line with a unit but no quantity is still a real purchase → count it as ONE
  // unit (a quantity-less receipt line is almost always a single item) rather than
  // dropping it. Dropping it was the bug behind "bought today, still shown overdue":
  // a fresh buy with a blank quantity vanished, so the last-bought anchor never moved.
  // (We default to 1, not the group median — multipacks like a 24-can tuna case would
  // otherwise make every blank line count as a whole case and explode the rate.)
  // €/base-unit used to impute the quantity of a weightless-but-priced line (e.g.
  // "Bananen 2,18" with no kg): the manual expected price, else the average €/base-
  // unit of the actually-weighed purchases. Internal to the estimate only — the raw
  // line and the €/kg comparison stay untouched (no circular feedback).
  let unitPrice = expectedUnitPrice != null && expectedUnitPrice > 0 ? expectedUnitPrice : null;
  if (unitPrice == null && (buKey === 'kg' || buKey === 'l')) {
    let sum = 0, cnt = 0;
    for (const l of lines) {
      const un = normalizeEinheit(l.einheit);
      const u = un ? units.get(un) : undefined;
      if (!u) continue;
      const k = u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : u.name;
      if (k !== buKey) continue;
      const p = toNum(l.preis ?? null), mm = toNum(l.menge);
      if (!(Number.isFinite(mm) && mm > 0)) continue; // only genuinely weighed purchases seed the price
      const q = mm * u.to_base;
      if (p > 0 && q > 0) { sum += p / q; cnt++; }
    }
    if (cnt) unitPrice = sum / cnt;
  }

  // Pass 1: classify every line into (group key, qty) WITHOUT summing yet — the
  // count-group sub-item fold below needs the median count quantity first.
  const buffered: { key: string; datum: string; qty: number; explicit: boolean }[] = [];
  for (const l of lines) {
    const un = normalizeEinheit(l.einheit);
    const u = un ? units.get(un) : undefined;
    const m = toNum(l.menge);
    const p = toNum(l.preis ?? null);
    let key: string, qty: number;
    if (!u && (buKey === 'kg' || buKey === 'l') && unitPrice && unitPrice > 0 && p > 0) {
      // Weightless line on a mass/volume product → impute kg/l from its total price.
      key = buKey;
      qty = p / unitPrice;
    } else {
      key = keyOf(u);
      const eff = Number.isFinite(m) && m > 0 ? m : 1;
      qty = u ? eff * u.to_base : eff;
    }
    // Price-leak guard: OCR sometimes writes the PRICE into menge ("5,49 stk" is a
    // 5,49 € line, not 5.49 packs). A count quantity ≥3 that equals the line's own
    // price to the cent is that leak → it's one item.
    if (key === 'Stück' && qty >= 3 && p > 0 && Math.abs(qty - p) < 0.005) qty = 1;
    if (qty <= 0) continue;
    buffered.push({ key, datum: l.datum, qty, explicit: !!u });
  }

  // Sub-item fold: receipts sometimes record the CONTENT count instead of the
  // container count — "Eier 18er" as menge=18 (eggs, ONE carton), "Cachet 8x85g"
  // as 8 (pouches, one multipack). A count quantity that's a hard outlier
  // (≥8 and ≥4× the median count line) is such a content count → one container.
  // Genuine multi-buys ("3 stk Kaffee", "x 4") stay untouched.
  const countQtys = buffered.filter(b => b.key === 'Stück').map(b => b.qty).sort((a, b) => a - b);
  const countMedian = countQtys.length ? countQtys[Math.floor(countQtys.length / 2)] : null;
  if (countMedian && countMedian > 0) {
    for (const b of buffered) {
      if (b.key === 'Stück' && b.qty >= 8 && b.qty >= 4 * countMedian) b.qty = 1;
    }
  }

  // Pass 2: sum per group + date; track per-LINE quantities (the mass→count fold
  // needs the typical weighed amount per receipt LINE: two 500g packs on one date
  // must read as two 0.5kg lines, not one 1kg purchase) and, per group, how many
  // lines carried a RECOGNIZED unit — blank-unit lines fall back to Stück but are
  // unit-AGNOSTIC, so they must not out-vote real units (see below).
  const groups = new Map<string, Map<string, number>>();
  const groupLines = new Map<string, number>();
  const lineQtys = new Map<string, number[]>();
  const explicitLines = new Map<string, number>();
  for (const b of buffered) {
    if (!groups.has(b.key)) groups.set(b.key, new Map());
    const pd = groups.get(b.key)!;
    pd.set(b.datum, (pd.get(b.datum) ?? 0) + b.qty);
    groupLines.set(b.key, (groupLines.get(b.key) ?? 0) + 1);
    if (!lineQtys.has(b.key)) lineQtys.set(b.key, []);
    lineQtys.get(b.key)!.push(b.qty);
    if (b.explicit) explicitLines.set(b.key, (explicitLines.get(b.key) ?? 0) + 1);
  }

  // Effective unit: the declared base_unit when we actually bought in it; else the
  // unit we most often EXPLICITLY bought in; else the biggest group overall (all
  // lines blank → Stück, as before). Explicit units only: blank-unit lines default
  // to Stück without meaning "pieces", and letting them out-vote real "2 kg" lines
  // made effKey=Stück, which silently DROPPED every kg purchase from the estimate
  // (the fold below only folds count→mass, not the reverse). Real-world case: 5×
  // "Möhren" (no unit) + 3× "Karotten 2kg" → Stück won, yesterday's 2 kg purchase
  // vanished, and Karotten were suggested the day after buying them.
  let effKey = buKey && groups.has(buKey) ? buKey : null;
  if (!effKey && explicitLines.size) effKey = [...explicitLines.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (!effKey && groupLines.size) effKey = [...groupLines.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (!effKey) effKey = buKey ?? 'Stück';

  // Display unit: internally all count units are one group ('Stück'); show the
  // user's declared count unit (e.g. "Packung") when it names the same dimension.
  const displayUnit = effKey === 'Stück' && baseUnitName && units.get(baseUnitName)?.dimension === 'count'
    ? baseUnitName : effKey;

  const perDate = new Map(groups.get(effKey) ?? new Map<string, number>());

  // Unit reconciliation, BOTH directions — no purchase line is ever dropped:
  // the same product is recorded inconsistently across receipts ("1 kg" one time,
  // "2 Stück" another, "500 g" another, no unit at all). Whatever group wins as
  // the effective unit, the OTHER groups fold into it instead of silently
  // vanishing from the rate (the root cause behind Karotten/Kaffeepulver being
  // suggested or shown empty right after buying them).
  if (effKey === 'kg' || effKey === 'l') {
    // Count → mass/volume: each piece = one typical pack (median real base-unit
    // purchase per DATE). NB: the base group may contain price-imputed weightless
    // lines (legitimate mass estimates); the fold may lean on that median too —
    // acceptable, and the only reference when nothing was actually weighed.
    const baseVals = [...(groups.get(effKey)?.values() ?? [])].sort((a, b) => a - b);
    const packSize = baseVals.length ? baseVals[Math.floor(baseVals.length / 2)] : null;
    if (packSize && packSize > 0) {
      for (const [k, pd] of groups) {
        if (k === effKey) continue;
        for (const [d, q] of pd) perDate.set(d, (perDate.get(d) ?? 0) + q * packSize);
      }
    }
  } else {
    // Mass/volume → count: a weighed line is (qty / typical pack mass) pieces,
    // pack mass = median per-LINE qty of that group (two 500g packs on one date
    // are two 0.5kg lines → 2 pieces, not one 1kg purchase). "Kaffee Gold 500g"
    // on a Packung-based product = 1 Packung.
    for (const [k, pd] of groups) {
      if (k === effKey) continue;
      const vals = [...(lineQtys.get(k) ?? [])].sort((a, b) => a - b);
      const packUnit = vals.length ? vals[Math.floor(vals.length / 2)] : null;
      if (!packUnit || packUnit <= 0) continue;
      for (const [d, q] of pd) perDate.set(d, (perDate.get(d) ?? 0) + q / packUnit);
    }
  }
  const dates = [...perDate.keys()].sort();
  const n = dates.length;
  const last_bought = n ? dates[n - 1] : null;
  if (!n) {
    const rem0 = override?.menge ?? null;
    const due0 = manualRate && rem0 != null ? Math.round((rem0 / manualRate) * 10) / 10 : null;
    return { base_unit: displayUnit, rate_per_day: manualRate, est_remaining: rem0, days_until_empty: due0, last_bought: null, typ_qty: null, override };
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
    base_unit: displayUnit,
    rate_per_day: effRate != null ? Math.round(effRate * 1000) / 1000 : null,
    est_remaining,
    days_until_empty,
    last_bought,
    typ_qty,
    override,
  };
}
