-- Per-household geocoded coordinates (cached from Nominatim), so offer + store lookups use
-- the household's OWN onboarding address instead of the platform operator's global config.
-- Self-host keeps these in app_config (household.lat / household.lon); demo needs them on the
-- RLS-scoped household row.
ALTER TABLE household ADD COLUMN IF NOT EXISTS lat NUMERIC;
ALTER TABLE household ADD COLUMN IF NOT EXISTS lon NUMERIC;
