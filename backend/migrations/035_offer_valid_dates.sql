-- Structured offer validity dates (from Marktguru validFrom/validTo) for the
-- upcoming shopping-recommendation epic: "läuft bald aus" (valid_to ≤ N days)
-- and "ab DD.MM. günstiger" (valid_from in the future). The human-readable
-- display string `valid_until` stays as-is.
ALTER TABLE offer ADD COLUMN IF NOT EXISTS valid_from DATE;
ALTER TABLE offer ADD COLUMN IF NOT EXISTS valid_to   DATE;
