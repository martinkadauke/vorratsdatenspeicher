-- Durable rejection memory. When a human rejects a churner proposal for an OCR
-- pattern, remember it so the churner won't re-mint the same proposal on its next
-- pass — breaking the reject → re-propose → reject loop. Keyed by ocr_key so it
-- survives the article id churn of a receipt rescan.
CREATE TABLE IF NOT EXISTS rejected_proposal (
  ocr_key            TEXT NOT NULL,
  proposed_canonical TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ocr_key, proposed_canonical)
);
