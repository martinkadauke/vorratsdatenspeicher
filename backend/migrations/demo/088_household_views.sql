-- 088_household_views.sql — Multi-tenant Phase 1 (c): rebuild the analytics views with
-- security_invoker=on (so base-table RLS applies through them — else a view runs as its superuser
-- owner and bypasses the household wall) and carry household_id on every arm. Behavior is identical
-- flag-off (all rows are household 1; the added household_id join is 1=1).

CREATE OR REPLACE VIEW v_artikel_consumer WITH (security_invoker = on) AS
  SELECT ac.artikel_id, ac.family_member_id, ac.household_id
    FROM artikel_consumer ac
  UNION
  SELECT a.id AS artikel_id, cc.family_member_id, a.household_id
    FROM artikel a
    JOIN canonical_consumer cc
      ON cc.canonical_name = a.canonical_name AND cc.household_id = a.household_id
   WHERE NOT EXISTS (SELECT 1 FROM artikel_consumer ac2 WHERE ac2.artikel_id = a.id);

CREATE OR REPLACE VIEW v_member_spend WITH (security_invoker = on) AS
  SELECT e.datum, e.konto_id, a.category_path, a.canonical_name,
         vac.family_member_id, fm.name AS family_member,
         ((a.preis / cnt.n::numeric))::numeric(12,2) AS amount,
         e.private_for_user_id, e.household_id
    FROM v_artikel_consumer vac
    JOIN artikel a       ON a.id = vac.artikel_id
    JOIN einkauf e       ON e.id = a.einkauf_id
    JOIN family_member fm ON fm.id = vac.family_member_id
    JOIN LATERAL (SELECT count(*)::integer AS n FROM v_artikel_consumer x WHERE x.artikel_id = a.id) cnt ON cnt.n > 0
   WHERE a.preis IS NOT NULL;

CREATE OR REPLACE VIEW v_transactions WITH (security_invoker = on) AS
  SELECT 'artikel'::text AS source_table, a.id AS source_id, e.datum,
         ((- a.preis))::numeric(12,2) AS amount, 'expense'::text AS direction,
         a.category_path, e.konto_id, e.quelle AS source,
         NULLIF(e.roh_ladenname, ''::text) AS counterparty, a.canonical_name,
         a.name AS description, e.private_for_user_id, e.household_id
    FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
   WHERE a.preis IS NOT NULL
  UNION ALL
  SELECT 'income'::text, i.id, i.datum, i.amount, 'income'::text,
         i.category_path, i.konto_id, 'income'::text,
         NULLIF(i.description, ''::text), NULL::text, i.description,
         NULL::integer, i.household_id
    FROM income i
  UNION ALL
  SELECT 'fixed_cost'::text, f.id, (gs.gs)::date,
         (((- f.monthly_eur) / (CASE f.frequency WHEN 'quarterly' THEN 3 WHEN 'yearly' THEN 12 ELSE 1 END)::numeric))::numeric(12,2),
         'expense'::text, f.category_path, f.konto_id, 'fixed'::text,
         f.label, NULL::text, f.label, NULL::integer, f.household_id
    FROM fixed_cost f
    CROSS JOIN LATERAL generate_series(date_trunc('month', f.start_date::timestamptz),
         date_trunc('month', (LEAST(COALESCE(f.end_date, CURRENT_DATE), CURRENT_DATE))::timestamptz), '1 mon'::interval) gs(gs)
   WHERE f.active AND f.kind = 'expense'::text AND NOT COALESCE(f.is_transfer, false);
