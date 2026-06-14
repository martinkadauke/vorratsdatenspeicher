-- Manual ordering for the Vorrat list (drag-and-drop, like the shopping list).
ALTER TABLE canonical_meta ADD COLUMN IF NOT EXISTS vorrat_sort INT;
