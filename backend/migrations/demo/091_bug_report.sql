-- 091_bug_report.sql — demo feedback channel. GLOBAL (no household_id column → not
-- RLS-scoped, so the platform super-admin reads every household's reports). user_id links
-- the reporter (plain int, no FK — survives household deletion); context holds page + household.
CREATE TABLE IF NOT EXISTS bug_report (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER,
  message    TEXT NOT NULL,
  context    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- vds_app (runtime) needs to INSERT reports; reads are super-admin-only via the owner conn.
GRANT SELECT, INSERT, UPDATE, DELETE ON bug_report TO vds_app;
GRANT USAGE, SELECT ON SEQUENCE bug_report_id_seq TO vds_app;
