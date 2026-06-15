// The Analytics semantic layer — the ONLY metrics, dimensions, grains, filters
// the agent (and the manual UI) may use. The LLM selects from these by key and
// fills typed params; it NEVER emits SQL and NEVER emits a number. Every entry
// maps to a fixed, audited SQL snippet over the read-only v_transactions ledger.
//
// Sign convention (from the view): expense amount < 0, income amount > 0.

export type Grain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export const GRAINS: Grain[] = ['day', 'week', 'month', 'quarter', 'year'];

export interface MetricDef {
  key: string;
  label: string;     // de
  label_en: string;
  unit: 'eur' | 'count';
  /** Aggregate SQL over v_transactions (alias t). Higher = "more". */
  expr: string;
}

export const METRICS: Record<string, MetricDef> = {
  spend: {
    key: 'spend', label: 'Ausgaben', label_en: 'Spending', unit: 'eur',
    expr: `SUM(CASE WHEN t.direction = 'expense' THEN -t.amount ELSE 0 END)`,
  },
  income: {
    key: 'income', label: 'Einnahmen', label_en: 'Income', unit: 'eur',
    expr: `SUM(CASE WHEN t.direction = 'income' THEN t.amount ELSE 0 END)`,
  },
  net: {
    key: 'net', label: 'Saldo (Einnahmen − Ausgaben)', label_en: 'Net (income − spend)', unit: 'eur',
    expr: `SUM(t.amount)`,
  },
  txn_count: {
    key: 'txn_count', label: 'Anzahl Buchungen', label_en: 'Transactions', unit: 'count',
    expr: `COUNT(*)`,
  },
  avg_expense: {
    key: 'avg_expense', label: 'Ø Ausgabe pro Buchung', label_en: 'Avg expense / item', unit: 'eur',
    expr: `COALESCE(AVG(CASE WHEN t.direction = 'expense' THEN -t.amount END), 0)`,
  },
};

const TIME_GRAIN_EXPR: Record<Grain, string> = {
  day: `to_char(t.datum, 'YYYY-MM-DD')`,
  week: `to_char(t.datum, 'IYYY-"W"IW')`,
  month: `to_char(t.datum, 'YYYY-MM')`,
  quarter: `to_char(t.datum, 'YYYY-"Q"Q')`,
  year: `to_char(t.datum, 'YYYY')`,
};
export const grainExpr = (g: Grain): string => TIME_GRAIN_EXPR[g];

export interface DimensionDef {
  key: string;
  label: string;
  label_en: string;
  /** Group expression producing a text bucket. */
  expr: string;
  needsKontoJoin?: boolean;
}

export const DIMENSIONS: Record<string, DimensionDef> = {
  category: {
    key: 'category', label: 'Kategorie (oberste Ebene)', label_en: 'Category (top level)',
    expr: `COALESCE(NULLIF(split_part(t.category_path, '/', 1), ''), 'Sonstiges')`,
  },
  category_full: {
    key: 'category_full', label: 'Kategorie (vollständig)', label_en: 'Category (full path)',
    expr: `COALESCE(t.category_path, 'Sonstiges')`,
  },
  source: {
    key: 'source', label: 'Quelle/Kanal', label_en: 'Source / channel',
    expr: `t.source`,
  },
  direction: {
    key: 'direction', label: 'Art (Ausgabe/Einnahme)', label_en: 'Direction (expense/income)',
    expr: `t.direction`,
  },
  konto: {
    key: 'konto', label: 'Konto', label_en: 'Account',
    expr: `COALESCE(k.name, '—')`, needsKontoJoin: true,
  },
  merchant: {
    key: 'merchant', label: 'Händler/Laden', label_en: 'Merchant / store',
    expr: `COALESCE(t.counterparty, '—')`,
  },
  product: {
    key: 'product', label: 'Produkt', label_en: 'Product',
    expr: `COALESCE(t.canonical_name, '—')`,
  },
};

/** Source-channel values that appear in v_transactions.source, with labels. */
export const SOURCES: Record<string, { label: string; label_en: string }> = {
  zettel: { label: 'Supermarkt (Kassenbon)', label_en: 'Supermarket (receipt)' },
  email: { label: 'Webshop/Rechnung (E-Mail)', label_en: 'Webshop/invoice (email)' },
  bar: { label: 'Barzahlung', label_en: 'Cash' },
  income: { label: 'Einnahme', label_en: 'Income' },
  fixed: { label: 'Fixkosten', label_en: 'Fixed cost' },
};

export interface FilterSpec {
  from?: string;            // ISO date, inclusive
  to?: string;             // ISO date, inclusive
  category?: string;        // category_path; matches it + descendants
  source?: string[];        // SOURCES keys
  direction?: 'expense' | 'income';
  konto_id?: number[];
  merchant?: string;        // substring (ILIKE)
  product?: string;         // canonical_name substring (ILIKE)
  min_amount?: number;      // on |amount|
  max_amount?: number;
  exclude_meta?: boolean;   // default true: drop Pfand/Rabatt meta categories
}

export interface AnalyticsQuery {
  metric: string;
  grain?: Grain | null;     // set → time series; omit → single value or by-dimension
  dimensions?: string[];    // DIMENSIONS keys (non-time)
  filters?: FilterSpec;
  order?: 'asc' | 'desc';
  limit?: number;
}

export interface ColumnMeta {
  time: Grain | null;
  dims: { key: string; label: string }[];
  value: { key: string; label: string; unit: 'eur' | 'count' };
}

export class AnalyticsError extends Error {}
