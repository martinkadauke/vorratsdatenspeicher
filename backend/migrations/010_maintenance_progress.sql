-- Live progress for long-running maintenance jobs. Updated frequently
-- (per batch) so the admin UI can render a real progress bar. Kept in a
-- separate column from `summary` so cheap progress writes don't churn the
-- final result payload.
ALTER TABLE maintenance_event ADD COLUMN IF NOT EXISTS progress JSONB;
