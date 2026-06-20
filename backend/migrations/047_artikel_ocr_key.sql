-- Persist the normalized OCR key on each artikel so dedup, "heal all OCR siblings
-- on one approval", and future drift-detection can group/join deterministically in
-- SQL. The normalization itself (ocrKey() in lib/canonicalAlias.ts) is JS-only and
-- cannot run in Postgres, so the value is written by app code at scan time and
-- backfilled once at boot (backfillArtikelOcrKey) for existing rows. Nullable —
-- a row whose ocr_key is still NULL just hasn't been filled yet.
ALTER TABLE artikel ADD COLUMN IF NOT EXISTS ocr_key TEXT;
CREATE INDEX IF NOT EXISTS ix_artikel_ocr_key ON artikel(ocr_key);
