-- Unit-review: a per-product "the tracking/pricing unit has been reviewed" marker.
-- The Prüfung queue surfaces products whose recommended unit (from purchase-history
-- variance: variable weight → kg, constant pack → Stück, drink → Flasche/Dose) differs
-- from the stored base_unit. Once the user applies OR keeps the current unit, we stamp
-- this so the product stops re-appearing. Forward-only: existing products with no stamp
-- are still eligible for review (that's the point — fix the mislabelled ones), but a
-- manual base_unit edit in Warenstamm also stamps it (see names.ts PATCH meta).
ALTER TABLE canonical_meta ADD COLUMN IF NOT EXISTS base_unit_confirmed_at TIMESTAMPTZ;

-- Seed the count units the recommender can emit but that weren't in the builtin set,
-- so the suggestion maps to a real unit row (and the UnitSelect dropdown offers them).
INSERT INTO unit (name, dimension, to_base, sort_order, builtin) VALUES
  ('Flasche', 'count', 1, 25, TRUE),
  ('Glas',    'count', 1, 35, TRUE)
ON CONFLICT (name) DO NOTHING;
