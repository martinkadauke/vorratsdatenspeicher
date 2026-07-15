-- 096_bug_report.sql — feedback channel available in ALL builds (not just demo), so the
-- release/self-host header "Feedback" button works. GLOBAL (no household_id → not RLS-scoped).
-- On demo this table already exists (demo/091 sorts first and grants vds_app); IF NOT EXISTS
-- makes this a harmless no-op there. Off-demo the single owner role needs no extra GRANT.
CREATE TABLE IF NOT EXISTS bug_report (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER,
  message    TEXT NOT NULL,
  context    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
