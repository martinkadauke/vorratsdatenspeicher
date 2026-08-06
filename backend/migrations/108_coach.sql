-- Progressive onboarding coach (FB-01): per-USER progress for the usage-triggered
-- coach-marks. Like push_subscription / notification_pref this is keyed by user_id with
-- NO household_id, so it stays exempt from the demo RLS invariant (the coach only runs
-- off-demo, but the table is harmless everywhere).
--   dismissed: stages the user permanently dismissed ("nicht mehr anzeigen"), e.g. {A,B}
--   events:    client-reported milestones not derivable from data, e.g. {"pruefen_visited": true}
CREATE TABLE IF NOT EXISTS user_onboarding (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dismissed  TEXT[]      NOT NULL DEFAULT '{}',
  events     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
