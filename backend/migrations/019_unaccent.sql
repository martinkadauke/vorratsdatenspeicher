-- Accent-insensitive search ("apfel" matches "Äpfel").
-- unaccent is a trusted contrib extension (createable by the DB owner since
-- PG13). Guarded so a permission failure degrades to plain ILIKE instead of
-- aborting the whole migration run — initSearch() detects availability at boot.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS unaccent;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'unaccent extension unavailable (%); search falls back to case-insensitive only', SQLERRM;
END $$;
