-- Manual ordering of line items within a receipt. Backfill existing rows
-- with their id so the current (id-ascending) order is preserved; new rows
-- (n8n / re-OCR inserts) leave it NULL and fall back to id ordering.
ALTER TABLE artikel ADD COLUMN IF NOT EXISTS sort_order INT;
UPDATE artikel SET sort_order = id WHERE sort_order IS NULL;
