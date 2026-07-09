-- Income becomes a first-class sibling of fixed costs. Rather than a parallel
-- table set, the recurring "plan" reuses fixed_cost with a `kind` discriminator
-- (expense | income) — same CRUD, same monthly-check + evidence-matching engine.
-- The old "salary as a NEGATIVE fixed cost" hack is migrated to positive
-- kind='income' rows, which fixes the double-count with actual pay-slip income.

ALTER TABLE fixed_cost ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'expense';

-- A fixed-cost check (for an income plan) can be backed by an actual income row
-- (a pay slip) — alongside einkauf_id (invoice) and bank_tx_id (bank line).
ALTER TABLE fixed_cost_check ADD COLUMN IF NOT EXISTS income_id INT REFERENCES income(id) ON DELETE SET NULL;

-- Migrate the negative-amount workaround → positive income plans. After this,
-- every fixed_cost amount is non-negative again (income lives in kind='income').
UPDATE fixed_cost SET kind = 'income', monthly_eur = -monthly_eur WHERE monthly_eur < 0;

-- Keep the analytics ledger correct: only EXPENSE plans are virtual monthly
-- expenses. Income plans are planning-only (the checklist); actual income stays
-- in the `income` table, so income is never double-counted here.
-- Column list must match the EXISTING view exactly (incl. private_for_user_id,
-- added by a later migration) — CREATE OR REPLACE can only ADD trailing columns,
-- never drop. Only change vs. current: the fixed_cost part filters kind='expense'.
CREATE OR REPLACE VIEW v_transactions AS
  SELECT
    'artikel'::text             AS source_table,
    a.id                        AS source_id,
    e.datum                     AS datum,
    (-a.preis)::numeric(12,2)   AS amount,
    'expense'::text             AS direction,
    a.category_path             AS category_path,
    e.konto_id                  AS konto_id,
    e.quelle                    AS source,
    NULLIF(e.roh_ladenname, '') AS counterparty,
    a.canonical_name            AS canonical_name,
    a.name                      AS description,
    e.private_for_user_id       AS private_for_user_id
  FROM artikel a
  JOIN einkauf e ON e.id = a.einkauf_id
  WHERE a.preis IS NOT NULL

  UNION ALL
  SELECT
    'income'::text, i.id, i.datum,
    i.amount::numeric(12,2),
    'income'::text,
    i.category_path,
    i.konto_id,
    'income'::text,
    NULLIF(i.description, ''),
    NULL::text,
    i.description,
    NULL::integer
  FROM income i

  UNION ALL
  SELECT
    'fixed_cost'::text, f.id, gs::date,
    (-f.monthly_eur)::numeric(12,2),
    'expense'::text,
    f.category_path,
    f.konto_id,
    'fixed'::text,
    f.label,
    NULL::text,
    f.label,
    NULL::integer
  FROM fixed_cost f
  CROSS JOIN LATERAL generate_series(
    date_trunc('month', f.start_date),
    date_trunc('month', LEAST(COALESCE(f.end_date, CURRENT_DATE), CURRENT_DATE)),
    interval '1 month'
  ) AS gs
  WHERE f.active AND f.kind = 'expense';

GRANT SELECT ON v_transactions TO analytics;
