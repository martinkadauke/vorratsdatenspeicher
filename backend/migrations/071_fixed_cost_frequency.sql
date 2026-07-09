-- Fixed costs can recur monthly / quarterly / yearly (e.g. GEZ ~56 €/quarter).
-- monthly_eur holds the amount charged PER OCCURRENCE (= the invoice amount, what
-- evidence matching compares against). The MONTHLY burden shown in budgets, the
-- month-view summaries and the analytics ledger is amortized: /1, /3, /12.
ALTER TABLE fixed_cost ADD COLUMN IF NOT EXISTS frequency TEXT NOT NULL DEFAULT 'monthly';

-- v_transactions: amortize the fixed-cost amount by frequency so a quarterly /
-- yearly charge is spread smoothly across its months instead of being counted at
-- full value every month (3x / 12x over-count). CREATE OR REPLACE VIEW cannot drop
-- or reorder columns (42P16) — the full current column list is reproduced verbatim;
-- only the fixed_cost amount expression changes.
CREATE OR REPLACE VIEW v_transactions AS
 SELECT 'artikel'::text AS source_table,
    a.id AS source_id,
    e.datum,
    (- a.preis)::numeric(12,2) AS amount,
    'expense'::text AS direction,
    a.category_path,
    e.konto_id,
    e.quelle AS source,
    NULLIF(e.roh_ladenname, ''::text) AS counterparty,
    a.canonical_name,
    a.name AS description,
    e.private_for_user_id
   FROM artikel a
     JOIN einkauf e ON e.id = a.einkauf_id
  WHERE a.preis IS NOT NULL
UNION ALL
 SELECT 'income'::text AS source_table,
    i.id AS source_id,
    i.datum,
    i.amount,
    'income'::text AS direction,
    i.category_path,
    i.konto_id,
    'income'::text AS source,
    NULLIF(i.description, ''::text) AS counterparty,
    NULL::text AS canonical_name,
    i.description,
    NULL::integer AS private_for_user_id
   FROM income i
UNION ALL
 SELECT 'fixed_cost'::text AS source_table,
    f.id AS source_id,
    gs.gs::date AS datum,
    (- f.monthly_eur / CASE f.frequency WHEN 'quarterly' THEN 3 WHEN 'yearly' THEN 12 ELSE 1 END)::numeric(12,2) AS amount,
    'expense'::text AS direction,
    f.category_path,
    f.konto_id,
    'fixed'::text AS source,
    f.label AS counterparty,
    NULL::text AS canonical_name,
    f.label AS description,
    NULL::integer AS private_for_user_id
   FROM fixed_cost f
     CROSS JOIN LATERAL generate_series(date_trunc('month'::text, f.start_date::timestamp with time zone), date_trunc('month'::text, LEAST(COALESCE(f.end_date, CURRENT_DATE), CURRENT_DATE)::timestamp with time zone), '1 mon'::interval) gs(gs)
  WHERE f.active AND f.kind = 'expense'::text;
