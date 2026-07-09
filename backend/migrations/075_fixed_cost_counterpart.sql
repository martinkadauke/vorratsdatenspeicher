-- 075_fixed_cost_counterpart.sql
-- Umbuchung (internal transfer) counterpart pairing.
--
-- A transfer between own accounts is two fixed-cost legs: e.g. -2000 leaving
-- Martin's account (kind=expense, is_transfer) and +2000 arriving on the
-- household account (kind=income, is_transfer). counterpart_id links the two
-- legs so the UI can show the money flow. The link is maintained symmetrically
-- by the application (A.counterpart_id = B  <=>  B.counterpart_id = A).
--
-- ON DELETE SET NULL keeps the surviving leg consistent when one leg is deleted:
-- deleting A nulls out B.counterpart_id automatically.
ALTER TABLE fixed_cost
  ADD COLUMN IF NOT EXISTS counterpart_id INTEGER REFERENCES fixed_cost(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_fixed_cost_counterpart
  ON fixed_cost(counterpart_id) WHERE counterpart_id IS NOT NULL;
