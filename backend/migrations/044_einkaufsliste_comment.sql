-- Per-item free-text comment on the shopping list (e.g. "die große Packung",
-- "Bio", "für Omas Geburtstag").
ALTER TABLE einkaufsliste_item ADD COLUMN IF NOT EXISTS comment TEXT;
