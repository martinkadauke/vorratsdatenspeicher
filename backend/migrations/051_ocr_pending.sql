-- Track whether a receipt's photo is currently being OCR'd in the background, so
-- the UI can show an accurate "wird analysiert…" state. Without it the frontend
-- guessed "has photo but zero items = still running", which stays true forever when
-- OCR legitimately finds no line items (e.g. a screenshot with only a total).
ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS ocr_pending BOOLEAN NOT NULL DEFAULT FALSE;
