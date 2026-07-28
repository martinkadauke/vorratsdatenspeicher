-- Demo-only spend guards.
--
-- demo.vorratsdatenspeicher.com lets anyone create a household with one click, and every
-- household is deleted again within 24h. Without ceilings a visitor (or a bot) could run the
-- vision OCR, the category-designer chat or the categoriser in a loop and burn the operator's
-- AI credit on data that is about to be thrown away.
--
-- These counters are CUMULATIVE and never decremented: counting live rows instead (e.g.
-- "how many receipts exist") is not a spend cap at all, because deleting a receipt would hand
-- the slot straight back while the tokens stay spent.
--
--   ocr_count   — vision OCR invocations (scan, attach photo, re-scan, mailbox import)
--   chat_count  — category-designer chat turns
--   recat_count — recategorisation runs
--
-- Lives in migrations/demo/ and therefore only ever runs when DEMO_MODE=true — self-hosted
-- and prod installs never get these columns and are never capped.
ALTER TABLE household ADD COLUMN IF NOT EXISTS recat_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE household ADD COLUMN IF NOT EXISTS ocr_count   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE household ADD COLUMN IF NOT EXISTS chat_count  INTEGER NOT NULL DEFAULT 0;
