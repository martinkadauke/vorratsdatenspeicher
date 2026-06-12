-- "Vollständig geprüft" flag: the human has verified every line item on
-- this receipt and considers it finished. Drives the review-progress bar
-- on the receipts overview.
ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS geprueft BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS ix_einkauf_geprueft ON einkauf(geprueft);
