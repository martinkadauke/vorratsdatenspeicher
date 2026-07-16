-- 097_bank_csv_format.sql — learned bank-CSV import mappings. Keyed by a fingerprint of the
-- header row so a bank's format is recognised on every future import. GLOBAL (no household_id):
-- a CSV layout is not sensitive and is reusable across households; accessed via the owner
-- connection (adminSql), like bug_report/maintenance_event.
CREATE TABLE IF NOT EXISTS bank_csv_format (
  id          BIGSERIAL PRIMARY KEY,
  fingerprint TEXT UNIQUE NOT NULL,
  label       TEXT,
  spec        JSONB NOT NULL,
  created_by  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
