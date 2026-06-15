-- Analytics data foundation: a UNIFIED, source-agnostic transaction ledger.
--
-- Today VDS only records expenses (artikel line items). Analytics must, from day
-- one, be able to reason about income AND expenses across many sources
-- (supermarket, cash, webshop, fixed costs, later bank/letter). We model that as
-- a single VIEW `v_transactions` with a SIGNED amount (expense < 0, income > 0)
-- and a `source` channel. New sources slot into the view without touching the
-- metrics layer or the agent.

-- ── Income (manual entry UI comes later; the model is ready now) ────────────
CREATE TABLE IF NOT EXISTS income (
  id            SERIAL PRIMARY KEY,
  datum         DATE NOT NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount >= 0),  -- stored positive; the view signs it +
  category_path TEXT,                                        -- free taxonomy (NOT the product category FK)
  konto_id      INT REFERENCES konto(id),
  source        TEXT NOT NULL DEFAULT 'other',               -- 'salary' | 'freelance' | 'gift' | 'refund' | 'other'
  description   TEXT,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_income_datum ON income(datum);
CREATE INDEX IF NOT EXISTS ix_income_konto ON income(konto_id);

-- ── Recurring fixed costs (insurance, loan annuity, subscriptions …) ────────
-- Stored once; the view expands each into one virtual monthly expense.
CREATE TABLE IF NOT EXISTS fixed_cost (
  id            SERIAL PRIMARY KEY,
  label         TEXT NOT NULL,                               -- "Kreditannuität Haus", "KFZ-Versicherung"
  category_path TEXT,
  monthly_eur   NUMERIC(12,2) NOT NULL CHECK (monthly_eur >= 0),
  konto_id      INT REFERENCES konto(id),
  start_date    DATE NOT NULL,
  end_date      DATE,                                        -- NULL = ongoing
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_fixed_konto ON fixed_cost(konto_id);

-- Date index for receipt-based aggregations (income/fixed have their own above).
CREATE INDEX IF NOT EXISTS ix_einkauf_datum ON einkauf(datum);

-- ── The unified ledger ──────────────────────────────────────────────────────
-- Faithful, raw ledger (business rules like "exclude Pfand/Rabatt from spend"
-- live in the metrics layer, applied once — never here).
CREATE OR REPLACE VIEW v_transactions AS
  -- (1) Receipt line items → expenses (signed negative)
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
    a.name                      AS description
  FROM artikel a
  JOIN einkauf e ON e.id = a.einkauf_id
  WHERE a.preis IS NOT NULL

  UNION ALL
  -- (2) Income (signed positive)
  SELECT
    'income'::text, i.id, i.datum,
    i.amount::numeric(12,2),
    'income'::text,
    i.category_path,
    i.konto_id,
    'income'::text,
    NULLIF(i.description, ''),
    NULL::text,
    i.description
  FROM income i

  UNION ALL
  -- (3) Fixed costs → one virtual monthly expense per active period
  SELECT
    'fixed_cost'::text, f.id, gs::date,
    (-f.monthly_eur)::numeric(12,2),
    'expense'::text,
    f.category_path,
    f.konto_id,
    'fixed'::text,
    f.label,
    NULL::text,
    f.label
  FROM fixed_cost f
  CROSS JOIN LATERAL generate_series(
    date_trunc('month', f.start_date),
    date_trunc('month', LEAST(COALESCE(f.end_date, CURRENT_DATE), CURRENT_DATE)),
    interval '1 month'
  ) AS gs
  WHERE f.active;

-- Read-only access for the analytics role (default privileges from 039 also
-- cover these; explicit grant is belt-and-braces).
GRANT SELECT ON income, fixed_cost, v_transactions TO analytics;
