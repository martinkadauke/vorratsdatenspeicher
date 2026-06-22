-- Manual weekly-consumption override per product. When set, estimateVorrat uses
-- this instead of the rate derived from purchase history (the "Vorrat" tab lets the
-- household correct an estimate the data gets wrong).
ALTER TABLE canonical_meta ADD COLUMN IF NOT EXISTS consumption_per_week DOUBLE PRECISION;
