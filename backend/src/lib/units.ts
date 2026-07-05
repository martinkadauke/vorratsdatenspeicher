import sql from '../db.js';

export interface UnitRow {
  name: string;
  dimension: 'count' | 'mass' | 'volume';
  to_base: number;
  sort_order: number;
  builtin: boolean;
}

/** Free-text einheit (as OCR'd) → a canonical unit name, or null if unknown.
 *  Keep this generous: the OCR/n8n side writes whatever the receipt printed. */
const EINHEIT_ALIASES: Record<string, string> = {
  stk: 'Stück', 'stk.': 'Stück', st: 'Stück', 'st.': 'Stück', stck: 'Stück',
  stueck: 'Stück', 'stück': 'Stück', stk_: 'Stück', x: 'Stück', stg: 'Stück',
  pack: 'Packung', pck: 'Packung', pkg: 'Packung', packung: 'Packung', pkt: 'Packung',
  dose: 'Dose', dosen: 'Dose', dse: 'Dose',
  flasche: 'Flasche', flaschen: 'Flasche', fl: 'Flasche', 'fl.': 'Flasche',
  glas: 'Glas', gläser: 'Glas', glaeser: 'Glas',
  kg: 'kg', kilo: 'kg', kilogramm: 'kg',
  g: 'g', gr: 'g', gramm: 'g', '100g': '100g',
  l: 'l', liter: 'l', ltr: 'l',
  ml: 'ml', milliliter: 'ml',
};

export function normalizeEinheit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase();
  if (!k) return null;
  return EINHEIT_ALIASES[k] ?? null;
}

export async function loadUnits(): Promise<Map<string, UnitRow>> {
  const rows = await sql`SELECT name, dimension, to_base::float8 AS to_base, sort_order, builtin FROM unit`;
  return new Map(rows.map(r => [r.name as string, r as unknown as UnitRow]));
}

export interface PriceLine { preis: number | string | null; menge: number | string | null; einheit: string | null }
export interface CompGroup { unit: string; dimension: string; avg: number; min: number; n: number }

const num = (v: number | string | null): number => {
  if (v == null) return NaN;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

/** Comparison-group key per DIMENSION: mass→'kg', volume→'l', count→'Stück'.
 *  ALL count units (Stück/Packung/Dose/Flasche/Glas…) are ONE family — the same
 *  product is OCR'd as "stk" one week and "Packung" the next, and splitting them
 *  fragmented the price history exactly like it fragmented the Vorrat estimate
 *  (the Kaffeepulver bug: a 2-line €/Packung bucket beat the 15-line €/Stück
 *  bucket depending on the call site). The single source for every price/unit
 *  grouping — routes must not roll their own copy. */
export function unitGroup(u: UnitRow | null | undefined): string | null {
  if (!u) return null;
  return u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : 'Stück';
}

/** Like unitGroup, from a raw unit NAME (already-normalized or canonical). */
export function unitGroupOf(units: Map<string, UnitRow>, name: string | null | undefined): string | null {
  return name ? unitGroup(units.get(name)) : null;
}

/** Collapse purchase lines into per-unit comparison prices.
 *  Mass→€/kg and volume→€/l (converted within the dimension); ALL count units
 *  form one group (see unitGroup). Lines with an empty/unknown unit are treated
 *  as Stück (qty = menge||1). */
export function comparisonGroups(lines: PriceLine[], units: Map<string, UnitRow>): CompGroup[] {
  // Content-count guard (same rule as the Vorrat estimator): receipts sometimes
  // record the CONTENT count instead of the container count — "Eier 18er" as
  // menge=18 for ONE 3,99 € carton. Divided naively that line contributes a bogus
  // 0,22 €/Stück to avg AND min. A count menge that's a hard outlier (≥8 and ≥4×
  // the median count line) whose per-piece price is also far below typical is such
  // a content count → price it as ONE container. Genuine bulk buys (per-piece
  // price ≈ typical) keep their real quantity.
  const cQtys: number[] = [], cPiece: number[] = [];
  for (const ln of lines) {
    const p = num(ln.preis);
    const uname = normalizeEinheit(ln.einheit) ?? 'Stück';
    const u = units.get(uname);
    if (!u || u.dimension !== 'count' || !Number.isFinite(p) || p <= 0) continue;
    const m = num(ln.menge);
    const q = Number.isFinite(m) && m > 0 ? m : 1;
    cQtys.push(q);
    cPiece.push(p / q);
  }
  cQtys.sort((a, b) => a - b); cPiece.sort((a, b) => a - b);
  const qMed = cQtys.length ? cQtys[Math.floor((cQtys.length - 1) / 2)] : null;
  const pMed = cPiece.length ? cPiece[Math.floor((cPiece.length - 1) / 2)] : null;

  const acc = new Map<string, { dimension: string; sum: number; min: number; n: number }>();
  for (const ln of lines) {
    const p = num(ln.preis);
    if (!Number.isFinite(p) || p <= 0) continue;
    const uname = normalizeEinheit(ln.einheit) ?? 'Stück';
    const u = units.get(uname);
    if (!u) continue;
    const m = num(ln.menge);
    let qty = (Number.isFinite(m) && m > 0 ? m : 1) * u.to_base;
    if (qty <= 0) continue;
    if (u.dimension === 'count' && qMed && qty >= 8 && qty >= 4 * qMed
        && (pMed == null || p / qty < 0.5 * pMed)) {
      qty = 1; // content count → one container at this line's total price
    }
    const unitPrice = p / qty; // €/kg, €/l, or €/count-unit
    const key = unitGroup(u)!;
    const g = acc.get(key) ?? { dimension: u.dimension, sum: 0, min: Infinity, n: 0 };
    g.sum += unitPrice;
    g.min = Math.min(g.min, unitPrice);
    g.n += 1;
    acc.set(key, g);
  }
  return [...acc.entries()]
    .map(([unit, g]) => ({
      unit,
      dimension: g.dimension,
      avg: Math.round((g.sum / g.n) * 100) / 100,
      min: Math.round(g.min * 100) / 100,
      n: g.n,
    }))
    .sort((a, b) => b.n - a.n);
}
