-- Fix: tenant-connection INSERTs that OMIT household_id took the constant DEFAULT 1,
-- so RLS `WITH CHECK (household_id = current_household)` rejected them for every
-- household but #1 → 500 errors (family member + account during a demo signup's
-- onboarding, and receipt creation, …). The migration comment in 086 promised a
-- "per-column default set at activation" that was never actually installed.
--
-- Install it now: a GUC-aware default on every household_id column. When the request
-- is tenant-scoped (openHousehold set app.current_household), the default resolves to
-- that household; otherwise it falls back to 1 (unchanged behaviour for owner/adminSql
-- inserts, which set household_id explicitly anyway). Explicit household_id values
-- always win over the default, so nothing that already sets it is affected.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'household_id' AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN household_id SET DEFAULT COALESCE(NULLIF(current_setting(''app.current_household'', true), '''')::bigint, 1)',
      r.table_name);
  END LOOP;
END $$;
