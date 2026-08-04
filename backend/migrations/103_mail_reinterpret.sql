-- AI-instructed import retry: a skipped/failed mail can be re-run with a user instruction
-- and become a corrected receipt OR a one-off income row.
--
-- Numbered 103, not 101: migrations/ (core) and migrations/demo/ share one schema_migrations
-- table sorted by filename (db.ts migrate()), and demo already holds 101_/102_. 103 keeps the
-- global sequence unambiguous on a demo instance.
--
-- imported_email.status is plain TEXT NOT NULL DEFAULT 'imported' with no CHECK (mig 053), so
-- the new 'income' status value needs no constraint change.

ALTER TABLE imported_email
  ADD COLUMN IF NOT EXISTS income_id   INT REFERENCES income(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS instruction TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at  TIMESTAMPTZ;   -- set at claim; drives the stale-'processing' sweep
