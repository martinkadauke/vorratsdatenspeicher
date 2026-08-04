-- 106_demo_refund_email_rls.sql — multi-tenant wiring for refund_email (core mig 105).
--
-- Runs ONLY on the demo DB (migrations/demo/ is applied on top of core; the merged set is
-- filename-sorted so this 106 runs AFTER core 105 that creates the table). On demo, mail
-- import + bank CSV are BOTH gated off, so refund_email never actually receives a row there
-- — this exists purely to keep the table consistent with every other tenant table (matching
-- how email_message got household_id in 086 + RLS in 089) and future-proof should mail import
-- ever be enabled on a multi-tenant install.

ALTER TABLE refund_email ADD COLUMN IF NOT EXISTS household_id BIGINT NOT NULL DEFAULT 1;
ALTER TABLE refund_email ADD CONSTRAINT refund_email_household_fk FOREIGN KEY (household_id) REFERENCES household(id);
CREATE INDEX IF NOT EXISTS ix_refund_email_household ON refund_email (household_id);

ALTER TABLE refund_email ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON refund_email
  USING      (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint)
  WITH CHECK (household_id = NULLIF(current_setting('app.current_household', true), '')::bigint);
