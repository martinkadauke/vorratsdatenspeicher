-- Per-receipt privacy replaces whole-account hiding. A receipt with
-- private_for_user_id = NULL is SHARED (everyone who can use the app sees it); a
-- receipt with it set is visible ONLY to that user — even the super-admin cannot
-- see another user's private receipt. Account membership no longer gates
-- visibility; kontoScope now filters on this column.
ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS private_for_user_id INT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_einkauf_private ON einkauf(private_for_user_id);

-- Recreate the unified ledger so analytics honors privacy too. The new column is
-- appended last (CREATE OR REPLACE VIEW allows adding trailing columns). Income and
-- fixed costs are never private → NULL.
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
    NULL::int
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
    NULL::int
  FROM fixed_cost f
  CROSS JOIN LATERAL generate_series(
    date_trunc('month', f.start_date),
    date_trunc('month', LEAST(COALESCE(f.end_date, CURRENT_DATE), CURRENT_DATE)),
    interval '1 month'
  ) AS gs
  WHERE f.active;

GRANT SELECT ON v_transactions TO analytics;

-- Per-member spend view also joins einkauf → must carry privacy so the
-- "wer verbraucht am meisten" analytics honors it too (trailing column).
CREATE OR REPLACE VIEW v_member_spend AS
  SELECT
    e.datum,
    e.konto_id,
    a.category_path,
    a.canonical_name,
    vac.family_member_id,
    fm.name                          AS family_member,
    (a.preis / cnt.n)::numeric(12,2) AS amount,
    e.private_for_user_id            AS private_for_user_id
  FROM v_artikel_consumer vac
  JOIN artikel a        ON a.id = vac.artikel_id
  JOIN einkauf e        ON e.id = a.einkauf_id
  JOIN family_member fm ON fm.id = vac.family_member_id
  JOIN LATERAL (SELECT COUNT(*)::int AS n FROM v_artikel_consumer x WHERE x.artikel_id = a.id) cnt ON cnt.n > 0
  WHERE a.preis IS NOT NULL;

GRANT SELECT ON v_member_spend TO analytics;
