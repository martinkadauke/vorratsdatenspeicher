-- Monthly to-do push reminders (1st/7th/15th): per-user opt-out, a per-day exactly-once
-- ledger, and a "don't show the e-mail-forwarding tutorial again" flag.
--
-- These are PER-USER tables (keyed by user_id, like push_subscription) with NO household_id,
-- so they are exempt from the demo RLS invariant (assertRlsCoverage only checks household_id
-- tables) and vds_app reaches them via the default-privileges grant from migration 089.

-- Per-user, per-category notification preference. NO row = opted IN (default true).
CREATE TABLE IF NOT EXISTS notification_pref (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL,               -- e.g. 'reminders'
  push       BOOLEAN NOT NULL DEFAULT TRUE,
  email      BOOLEAN NOT NULL DEFAULT TRUE,  -- reserved; reminders are push-only for now
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, kind)
);

-- Exactly-once ledger for the monthly reminder cron. The (kind, run_date) PK + an
-- INSERT ... ON CONFLICT DO NOTHING claim makes the batch fire ONCE across both swarm
-- replicas (in-memory flags can't dedupe cross-process) and idempotent on manual re-runs.
CREATE TABLE IF NOT EXISTS reminder_run (
  kind     TEXT NOT NULL,                    -- e.g. 'reminder.day7'
  run_date DATE NOT NULL,
  ran_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, run_date)
);

-- Cross-device "don't show the e-mail-forwarding tutorial again" flag (mirrors has_seen_tour).
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_seen_email_tutorial BOOLEAN DEFAULT FALSE;
