-- Manual override for a product's expected unit price (€ per base_unit, i.e. the
-- Grundpreis). Used on the shopping list when the history-derived average is wrong.
ALTER TABLE canonical_meta ADD COLUMN IF NOT EXISTS expected_price NUMERIC;
