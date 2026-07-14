-- Demo: ephemeral households + per-household onboarding.
--
-- (1) is_demo           — signup-created households are ephemeral; the nightly demo
--                          sweep (demo_sweep cron) deletes them + all their data.
-- (2) onboarding_done   — first-run wizard state PER HOUSEHOLD (app_config is global,
--                          so it can't drive a per-household wizard). Each new signup
--                          starts false → sees the slim onboarding.
-- (3) address / categories_detail — a demo household admin's slim-onboarding answers,
--                          kept on their own row instead of clobbering the global
--                          household.address / categories.detail operator config.
ALTER TABLE household ADD COLUMN IF NOT EXISTS is_demo            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE household ADD COLUMN IF NOT EXISTS onboarding_done    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE household ADD COLUMN IF NOT EXISTS address            TEXT;
ALTER TABLE household ADD COLUMN IF NOT EXISTS categories_detail  TEXT;

-- Household 1 = the platform / super-admin household: already set up, never swept.
UPDATE household SET onboarding_done = TRUE, is_demo = FALSE WHERE id = 1;
