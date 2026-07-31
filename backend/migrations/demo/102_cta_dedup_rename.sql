-- Repair for 101: rename demo_cta_click.household_id → dedup_household.
--
-- WHY THIS BROKE THE DEMO. db.ts assertRlsCoverage() is a boot invariant: any table in `public`
-- carrying a `household_id` column that lacks RLS + a `tenant_isolation` policy makes the app
-- REFUSE TO START. That is deliberate and good — it is what stops a tenant table shipping without
-- isolation. demo_cta_click is not tenant data (it is operator telemetry, written and read only
-- through adminSql), but naming its dedup key `household_id` made it indistinguishable from one,
-- so the invariant fired and the demo came up 502.
--
-- The fix is the name, not the invariant. Adding RLS here would be worse: it would assert this is
-- household-owned data, when the whole design point is that a household never reads it and the
-- rows deliberately outlive the nightly sweep. `dedup_household` says what the column is for —
-- deduplication — and no longer claims ownership.
--
-- Separate migration rather than editing 101: 101 has already applied and committed on the demo,
-- so amending it in place would leave that database and the file permanently out of step. A fresh
-- install runs 101 then 102 in order and reaches the same end state, before the boot check runs.
DO $$
BEGIN
  IF to_regclass('public.demo_cta_click') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'demo_cta_click'
               AND column_name = 'household_id') THEN
    -- The partial unique index rides along with the rename automatically (it is defined over the
    -- column, not its name), so the one-row-per-household-per-target-per-day cap is preserved.
    ALTER TABLE demo_cta_click RENAME COLUMN household_id TO dedup_household;
  END IF;
END $$;
