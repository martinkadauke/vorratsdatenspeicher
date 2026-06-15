-- Audit trail for the NL analytics agent: every question, the spec it produced,
-- and whether it executed. Pure observability (written by the app, never by the
-- read-only analytics role) — useful for trust, debugging and prompt tuning.
CREATE TABLE IF NOT EXISTS nlanalytics_log (
  id         SERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id) ON DELETE SET NULL,
  question   TEXT NOT NULL,
  spec       JSONB,
  ok         BOOLEAN NOT NULL DEFAULT TRUE,
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_nlanalytics_log_created ON nlanalytics_log(created_at DESC);
