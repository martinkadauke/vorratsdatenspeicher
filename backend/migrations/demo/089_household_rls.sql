-- 089_household_rls.sql — Multi-tenant: enable Row-Level Security for household isolation.
--
-- The runtime connects as the NON-OWNER role vds_app (no BYPASSRLS). A query with no
-- app.current_household set returns ZERO rows (fail closed) — a forgotten scope can never
-- leak another household. Migrations + platform cross-household ops run as the OWNER, which
-- bypasses RLS (we intentionally do NOT use FORCE, so owner DML in future migrations still
-- works and the owner connection is the platform/super-admin bypass). The 'household'
-- registry table is deliberately NOT RLS'd — it is how the platform enumerates tenants.
--
-- SAFE TO SHIP NOW: while the app still connects as the owner, ENABLE RLS is a no-op
-- (owner bypasses). Isolation activates only once DATABASE_URL points at vds_app + the
-- per-request GUC is set (the runtime-wiring phase).

-- 1) Non-owner runtime role (password/login configured out-of-band at deploy).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vds_app') THEN
    CREATE ROLE vds_app LOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO vds_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vds_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vds_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vds_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO vds_app;

-- 2) Per tenant table: enable RLS + the uniform isolation policy.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE konto ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON konto
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE family_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON family_member
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE einkauf ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON einkauf
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE artikel ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON artikel
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE artikel_consumer ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON artikel_consumer
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE artikel_ausschluss ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON artikel_ausschluss
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE auth_token ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_token
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE bank_match_suggestion ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_match_suggestion
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE bank_tx ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_tx
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE budget ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE budget_category ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget_category
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE canonical_alias ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_alias
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE canonical_consumer ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_consumer
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE canonical_meta ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_meta
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE canonical_translation ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canonical_translation
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE category ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON category
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE einkaufsliste ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON einkaufsliste
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE einkaufsliste_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON einkaufsliste_item
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE email_message ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_message
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE fixed_cost ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_cost
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE fixed_cost_check ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fixed_cost_check
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE imported_email ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON imported_email
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE imported_file ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON imported_file
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE income ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON income
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE merchant_konto ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON merchant_konto
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE nlanalytics_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nlanalytics_log
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE offer ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON offer
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE offer_subscription ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON offer_subscription
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE push_subscription ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON push_subscription
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE rejected_proposal ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rejected_proposal
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE reserve_charge ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reserve_charge
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE shopping_list ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shopping_list
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE shopping_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shopping_session
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE spending_goal ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON spending_goal
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE store_branch ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON store_branch
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE user_mailbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_mailbox
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE verifikations_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON verifikations_queue
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE vorrat_override ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vorrat_override
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);

ALTER TABLE vorschlag_snooze ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vorschlag_snooze
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);
