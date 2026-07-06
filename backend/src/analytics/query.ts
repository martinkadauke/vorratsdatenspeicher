// Deterministic query builder: a validated AnalyticsQuery → ONE parameterized
// SELECT over v_transactions. Identifiers come only from the catalog (never from
// the LLM/user); every value is a bound $n placeholder. Executed via
// analyticsRead → least-privilege, read-only, timeout-capped. This is why a
// wrong or adversarial intent can return bad numbers AT WORST, never mutate, and
// why every figure is traceable to the SQL we return alongside it.

import { analyticsRead } from '../db.js';
import type { User } from '../types.js';
import {
  METRICS, DIMENSIONS, GRAINS, grainExpr, MEMBER_DIM,
  type AnalyticsQuery, type ColumnMeta, AnalyticsError,
} from './catalog.js';

const MAX_ROWS = 1000;
const DEFAULT_ROWS = 200;

// Runtime validators — the route accepts untrusted JSON, and TypeScript types are
// erased at runtime, so every value must be checked before it reaches SQL. Bad
// input throws AnalyticsError → 400 (not a 500 from a Postgres coercion error).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function asDate(v: unknown, field: string): string {
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new AnalyticsError(`invalid ${field} (expected date YYYY-MM-DD)`);
  }
  return v;
}
function asNum(v: unknown, field: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new AnalyticsError(`invalid ${field} (expected number)`);
  return n;
}

/** Replicate kontoScope() as bound params (analyticsRead takes raw text + params).
 *  Per-receipt privacy: a private transaction is visible to its owner and to a
 *  super-admin (sees_all_konten = "kann alles sehen", no exception). */
function kontoWhere(user: User | undefined, params: unknown[]): string | null {
  if (!user || user.sees_all_konten) return null;
  return `(t.private_for_user_id IS NULL OR t.private_for_user_id = $${params.push(user.id)})`;
}

export interface BuiltQuery { text: string; params: unknown[]; columns: ColumnMeta }

export function buildAnalyticsSql(q: AnalyticsQuery, user: User | undefined): BuiltQuery {
  // Per-person spending uses a different base (price split across taggers).
  if ((q.dimensions ?? []).includes(MEMBER_DIM)) return buildMemberSql(q, user);

  const metric = METRICS[q.metric];
  if (!metric) throw new AnalyticsError(`unknown metric "${q.metric}"`);

  const dims = (q.dimensions ?? []).map(key => {
    const def = DIMENSIONS[key];
    if (!def) throw new AnalyticsError(`unknown dimension "${key}"`);
    return def;
  });
  if (dims.length > 3) throw new AnalyticsError('at most 3 dimensions');

  const grain = q.grain ?? null;
  if (grain && !GRAINS.includes(grain)) throw new AnalyticsError(`unknown grain "${grain}"`);

  const params: unknown[] = [];
  const where: string[] = [];

  const ks = kontoWhere(user, params);
  if (ks) where.push(ks);

  const f = q.filters ?? {};
  if (f.from) where.push(`t.datum >= $${params.push(asDate(f.from, 'from'))}`);
  if (f.to) where.push(`t.datum <= $${params.push(asDate(f.to, 'to'))}`);
  if (f.direction) {
    if (f.direction !== 'expense' && f.direction !== 'income') throw new AnalyticsError('bad direction');
    where.push(`t.direction = $${params.push(f.direction)}`);
  }
  if (f.category) {
    const a = params.push(String(f.category));
    const b = params.push(`${String(f.category)}/%`);
    where.push(`(t.category_path = $${a} OR t.category_path LIKE $${b})`);
  }
  if (f.source?.length) {
    const ph = f.source.map(s => `$${params.push(String(s))}`).join(', ');
    where.push(`t.source IN (${ph})`);
  }
  if (f.konto_id?.length) {
    // Accounts are no longer hidden — anyone may filter by any account; private
    // receipts within it stay hidden via the privacy predicate above.
    const ids = f.konto_id.map(id => asNum(id, 'konto_id'));
    const ph = ids.map(id => `$${params.push(id)}`).join(', ');
    where.push(`t.konto_id IN (${ph})`);
  }
  if (f.merchant) where.push(`t.counterparty ILIKE $${params.push(`%${String(f.merchant)}%`)}`);
  if (f.product) where.push(`t.canonical_name ILIKE $${params.push(`%${String(f.product)}%`)}`);
  if (f.min_amount != null) where.push(`ABS(t.amount) >= $${params.push(asNum(f.min_amount, 'min_amount'))}`);
  if (f.max_amount != null) where.push(`ABS(t.amount) <= $${params.push(asNum(f.max_amount, 'max_amount'))}`);

  const excludeMeta = f.exclude_meta !== false;        // default on (matches existing spend stats)
  const needKontoJoin = dims.some(d => d.needsKontoJoin);

  const select: string[] = [];
  const groupExprs: string[] = [];
  const columns: ColumnMeta = {
    time: grain,
    dims: dims.map(d => ({ key: d.key, label: d.label })),
    value: { key: metric.key, label: metric.label, unit: metric.unit },
  };

  if (grain) { select.push(`${grainExpr(grain)} AS bucket`); groupExprs.push(grainExpr(grain)); }
  dims.forEach((d, i) => { select.push(`${d.expr} AS d${i}`); groupExprs.push(d.expr); });
  select.push(`${metric.expr} AS value`);

  let text = `SELECT ${select.join(', ')} FROM v_transactions t`;
  if (needKontoJoin) text += ` LEFT JOIN konto k ON k.id = t.konto_id`;
  if (excludeMeta) {
    text += ` LEFT JOIN category c ON c.path = t.category_path`;
    // Meta (Pfand/Rabatt) only applies to receipt line items. Guard on source_table
    // so a future meta-tagged income/fixed row is never silently dropped.
    where.push(`(t.source_table <> 'artikel' OR c.is_meta IS NOT TRUE)`);
  }
  if (where.length) text += ` WHERE ${where.join(' AND ')}`;
  if (groupExprs.length) text += ` GROUP BY ${groupExprs.join(', ')}`;

  if (grain) text += ` ORDER BY bucket ASC`;
  else if (dims.length) text += ` ORDER BY value ${q.order === 'asc' ? 'ASC' : 'DESC'}`;

  const cap = Math.min(Math.max(1, Math.floor(q.limit != null ? asNum(q.limit, 'limit') : DEFAULT_ROWS)), MAX_ROWS);
  text += ` LIMIT ${cap}`;

  return { text, params, columns };
}

// Per-member spending over v_member_spend. Only `spend` makes sense here (each
// row is already a positive spend share); supports family_member + category /
// product / time dims and date/category/konto/product filters.
function buildMemberSql(q: AnalyticsQuery, user: User | undefined): BuiltQuery {
  const dims = (q.dimensions ?? []).map(key => {
    if (key === MEMBER_DIM) return { key, label: DIMENSIONS.family_member.label, expr: `t.family_member` };
    if (key === 'category') return { key, label: DIMENSIONS.category.label, expr: `COALESCE(NULLIF(split_part(t.category_path, '/', 1), ''), 'Sonstiges')` };
    if (key === 'category_full') return { key, label: DIMENSIONS.category_full.label, expr: `COALESCE(t.category_path, 'Sonstiges')` };
    if (key === 'product') return { key, label: DIMENSIONS.product.label, expr: `COALESCE(t.canonical_name, '—')` };
    throw new AnalyticsError(`dimension "${key}" is not available per family member`);
  });
  if (dims.length > 3) throw new AnalyticsError('at most 3 dimensions');
  const grain = q.grain ?? null;
  if (grain && !GRAINS.includes(grain)) throw new AnalyticsError(`unknown grain "${grain}"`);

  const params: unknown[] = [];
  const where: string[] = [];
  const ks = kontoWhere(user, params);          // v_member_spend has konto_id
  if (ks) where.push(ks);

  const f = q.filters ?? {};
  if (f.from) where.push(`t.datum >= $${params.push(asDate(f.from, 'from'))}`);
  if (f.to) where.push(`t.datum <= $${params.push(asDate(f.to, 'to'))}`);
  if (f.category) {
    const a = params.push(String(f.category));
    const b = params.push(`${String(f.category)}/%`);
    where.push(`(t.category_path = $${a} OR t.category_path LIKE $${b})`);
  }
  if (f.konto_id?.length) {
    // Accounts no longer hidden; private receipts stay hidden via kontoWhere.
    const ids = f.konto_id.map(id => asNum(id, 'konto_id'));
    where.push(`t.konto_id IN (${ids.map(id => `$${params.push(id)}`).join(', ')})`);
  }
  if (f.product) where.push(`t.canonical_name ILIKE $${params.push(`%${String(f.product)}%`)}`);
  const excludeMeta = f.exclude_meta !== false;

  const select: string[] = [];
  const groupExprs: string[] = [];
  const columns: ColumnMeta = {
    time: grain,
    dims: dims.map(d => ({ key: d.key, label: d.label })),
    value: { key: 'spend', label: METRICS.spend.label, unit: 'eur' },
  };
  if (grain) { select.push(`${grainExpr(grain)} AS bucket`); groupExprs.push(grainExpr(grain)); }
  dims.forEach((d, i) => { select.push(`${d.expr} AS d${i}`); groupExprs.push(d.expr); });
  select.push(`SUM(t.amount) AS value`);

  let text = `SELECT ${select.join(', ')} FROM v_member_spend t`;
  if (excludeMeta) {
    text += ` LEFT JOIN category c ON c.path = t.category_path`;
    where.push(`(c.is_meta IS NOT TRUE)`);
  }
  if (where.length) text += ` WHERE ${where.join(' AND ')}`;
  if (groupExprs.length) text += ` GROUP BY ${groupExprs.join(', ')}`;
  if (grain) text += ` ORDER BY bucket ASC`;
  else if (dims.length) text += ` ORDER BY value ${q.order === 'asc' ? 'ASC' : 'DESC'}`;
  const cap = Math.min(Math.max(1, Math.floor(q.limit != null ? asNum(q.limit, 'limit') : DEFAULT_ROWS)), MAX_ROWS);
  text += ` LIMIT ${cap}`;
  return { text, params, columns };
}

export interface AnalyticsRow { bucket?: string; dims: (string | null)[]; value: number }
export interface AnalyticsResult { rows: AnalyticsRow[]; columns: ColumnMeta; sql: string }

export async function runAnalyticsQuery(q: AnalyticsQuery, user: User | undefined): Promise<AnalyticsResult> {
  const { text, params, columns } = buildAnalyticsSql(q, user);
  const raw = await analyticsRead<Record<string, unknown>>(text, params);
  const rows: AnalyticsRow[] = raw.map(r => ({
    bucket: columns.time ? String(r.bucket ?? '') : undefined,
    dims: columns.dims.map((_, i) => (r[`d${i}`] == null ? null : String(r[`d${i}`]))),
    value: r.value == null ? 0 : Number(r.value),
  }));
  // Note: `params` (which includes the user's konto_ids) intentionally NOT returned
  // — the displayed `sql` keeps $n placeholders; values stay server-side.
  return { rows, columns, sql: text };
}
