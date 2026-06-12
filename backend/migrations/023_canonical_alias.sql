-- Learned OCR→canonical aliases. Whenever an item gets a canonical name (by the
-- matcher, the churner LLM, or a manual edit) we remember the mapping keyed by a
-- normalized form of the raw OCR text. The next time the same text is scanned it
-- inherits the canonical instantly — no LLM, 100% reliable for repeats.
CREATE TABLE IF NOT EXISTS canonical_alias (
  ocr_key        TEXT PRIMARY KEY,        -- normalized raw OCR text, e.g. "bio banan"
  canonical_name TEXT NOT NULL,
  count          INT NOT NULL DEFAULT 1,  -- how often this mapping was reinforced
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_canonical_alias_canon ON canonical_alias(canonical_name);
