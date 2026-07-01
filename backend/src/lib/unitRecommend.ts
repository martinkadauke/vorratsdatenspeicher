// Recommend a canonical product's pricing/tracking unit from its purchase history.
//
// Principle (from real top-100 evidence): default to the PURCHASE unit — what one
// item in the cart is (piece / pack / bottle / can). Switch to kg/l ONLY when the
// product is genuinely bought by a *variable* weight/volume (loose/weighed). The key
// discriminator is the VARIANCE of the recorded weight: a variable weight = weighed
// loose (→ kg); a constant weight (always ~160 g) = a fixed package (→ piece), NOT kg.
// This is deliberate — "it has a gram figure → use kg" is the trap that mislabels
// packaged goods. Output is a SUGGESTION (confidence + rationale) for the review queue;
// a manual/confirmed unit always wins and is never overwritten.
import { normalizeEinheit, type UnitRow } from './units.js';

type Units = Map<string, UnitRow>;
export interface RecoLine { menge: string | number | null; einheit: string | null }
export interface UnitReco {
  unit: string;                       // recommended base_unit (kg | l | Stück | Flasche | …)
  kind: 'weight' | 'volume' | 'count';
  confidence: number;                 // 0..1
  rationale: string;                  // short human-readable reason
  signal: string;                     // which rule fired (audit/telemetry)
}

const num = (v: string | number | null): number => {
  if (v == null) return NaN;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const median = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const cov = (a: number[]): number => {
  if (a.length < 2) return 0;
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  if (mean <= 0) return 0;
  const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
  return sd / mean;
};

// Categories where goods are plausibly sold by variable weight (produce/counter) —
// only BOOSTS confidence; the weight-variance signal is the real decider.
const WEIGHABLE = ['Lebensmittel/Obst & Gemüse', 'Lebensmittel/Fleisch', 'Lebensmittel/Milch & Eier/Käse'];
const VAR = 0.12;        // weight coefficient-of-variation threshold: above → weighed/loose
const MIN_WEIGH = 3;     // min weighed purchases before the variance signal is trusted
const WEIGH_SHARE = 0.4; // …and they must be a real share of purchases (not a few outliers)

export function recommendUnit(lines: RecoLine[], category: string | null, units: Units): UnitReco {
  const mass: number[] = [], vol: number[] = [];
  const counts = new Map<string, number>();
  for (const l of lines) {
    const un = normalizeEinheit(l.einheit);
    if (!un) continue;
    const u = units.get(un);
    if (!u) continue;                                 // blank/unknown unit → no signal from this line
    const m = num(l.menge);
    if (u.dimension === 'mass') { if (m > 0) mass.push(m * u.to_base); }
    else if (u.dimension === 'volume') { if (m > 0) vol.push(m * u.to_base); }
    else counts.set(un, (counts.get(un) ?? 0) + 1);   // count unit (Stück/Flasche/Dose/Packung/Glas)
  }
  const total = lines.length || 1;
  const cat = category ?? '';
  const weighable = WEIGHABLE.some(c => cat.startsWith(c));
  // Bottled/canned drinks — never priced by kg/l here (a "0.5 l" is the bottle size,
  // not a weighed amount). Coffee & tea sit under "Getränke" too but are packaged
  // goods sold by the bag/box, so they're excluded from the beverage rule.
  const isBev = cat.includes('Soft Drinks') || (cat.includes('Getränke') && !cat.includes('Kaffee') && !cat.includes('Tee'));

  // The best count/piece unit to suggest. Only ever return a NON-generic count unit
  // (Flasche/Dose/Glas/Packung) if it actually appears in the purchase history — an
  // invented unit (e.g. Flasche for a drink only ever recorded in litres) wouldn't
  // match any line, so comparisonGroups/estimateVorrat can't form a group for it and
  // the €/base-unit comparison silently breaks. Fixed packs fall back to the generic
  // Stück (eggs → Packung), whose price is carried by the auto-filled expected_price.
  const countUnit = (): string => {
    const explicit = [...counts.entries()].filter(([u]) => u !== 'Stück').sort((a, b) => b[1] - a[1]);
    if (explicit.length) return explicit[0][0];
    if (cat.includes('/Eier')) return 'Packung';
    return 'Stück';
  };

  // 1. Variable weight/volume that's a real share of purchases → weighed loose → kg/l.
  //    Guard: a variable *weight* only means loose-weighing for genuinely weighable
  //    goods (produce/meat/deli). Elsewhere a spread of gram figures is pack-size
  //    variety (85 g pouch vs 400 g can of cat food) or a printed pack label — NOT
  //    weighing — so those must fall through to a count/pack unit. Likewise beverages
  //    are never bulk-litre, so their volume spread (single can vs multipack) is skipped.
  const mCov = cov(mass), vCov = cov(vol);
  if (weighable && mass.length >= Math.max(MIN_WEIGH, total * WEIGH_SHARE) && mCov > VAR)
    return { unit: 'kg', kind: 'weight', confidence: 0.9, rationale: `lose gewogen — Gewicht schwankt (±${Math.round(mCov * 100)} %)`, signal: 'weight_variance' };
  if (!isBev && vol.length >= Math.max(MIN_WEIGH, total * WEIGH_SHARE) && vCov > VAR)
    return { unit: 'l', kind: 'volume', confidence: weighable ? 0.85 : 0.7, rationale: `variables Volumen (±${Math.round(vCov * 100)} %)`, signal: 'volume_variance' };

  // 2. A dominant count unit → buy it by the piece/pack/bottle
  const dom = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dom && dom[1] >= Math.max(2, total * 0.3)) {
    const u = countUnit();
    return { unit: u, kind: 'count', confidence: dom[1] / total > 0.5 ? 0.85 : 0.65, rationale: `meist als „${u}" gekauft`, signal: 'dominant_unit' };
  }

  // 3. A constant weight (fixed pack) with no dominant count unit → package, NOT kg
  if (mass.length >= 2 && mCov <= VAR)
    return { unit: countUnit(), kind: 'count', confidence: 0.75, rationale: `feste Packung (~${Math.round(median(mass) * 1000)} g konstant)`, signal: 'fixed_pack' };

  // 4. Recorded mainly by volume with no count evidence (a typical drink) → price per
  //    litre, matching the existing Grundpreis seeder. We deliberately do NOT invent a
  //    Flasche/Dose here (see countUnit): 'l' is the unit the purchases actually form.
  if (vol.length >= 2 && counts.size === 0 && vol.length >= mass.length)
    return { unit: 'l', kind: 'volume', confidence: isBev ? 0.72 : 0.6, rationale: 'nach Volumen berechnet', signal: 'volume_default' };

  // 5. Default: the purchase unit (mostly blank quantities / Menge = 1)
  return { unit: countUnit(), kind: 'count', confidence: 0.55, rationale: 'Kaufeinheit (kein variables Gewicht)', signal: 'default_piece' };
}
