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

/** Collapse purchase lines into per-unit comparison prices.
 *  Mass→€/kg and volume→€/l (converted within the dimension); count units
 *  (Stück/Packung/Dose) each stay their own group — they are not interconvertible.
 *  Lines with an empty/unknown unit are treated as Stück (qty = menge||1). */
export function comparisonGroups(lines: PriceLine[], units: Map<string, UnitRow>): CompGroup[] {
  const acc = new Map<string, { dimension: string; sum: number; min: number; n: number }>();
  for (const ln of lines) {
    const p = num(ln.preis);
    if (!Number.isFinite(p) || p <= 0) continue;
    const uname = normalizeEinheit(ln.einheit) ?? 'Stück';
    const u = units.get(uname);
    if (!u) continue;
    const m = num(ln.menge);
    const qty = (Number.isFinite(m) && m > 0 ? m : 1) * u.to_base;
    if (qty <= 0) continue;
    const unitPrice = p / qty; // €/kg, €/l, or €/count-unit
    const key = u.dimension === 'mass' ? 'kg' : u.dimension === 'volume' ? 'l' : uname;
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
