-- Bank-CSV import (comdirect). Adds:
--  • ref           the bank's unique transaction reference ("Ref. …") → idempotent
--                  re-import: the same row is never imported twice.
--  • purchase_date the real card-purchase date embedded in the Buchungstext; the
--                  booking date lags a few days, so this makes receipt matching tighter.
--  • einkauf.bank_tx_id  the bidirectional receipt <-> bank-transaction link.
ALTER TABLE bank_tx ADD COLUMN IF NOT EXISTS ref TEXT;
ALTER TABLE bank_tx ADD COLUMN IF NOT EXISTS purchase_date DATE;
-- Dedup on (konto, ref); refs are unique per statement. Partial → tolerates rows
-- from a future bank that has no ref (they fall back to app-level checks).
CREATE UNIQUE INDEX IF NOT EXISTS ux_bank_tx_ref ON bank_tx(konto_id, ref) WHERE ref IS NOT NULL;

ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS bank_tx_id INT REFERENCES bank_tx(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_einkauf_bank_tx ON einkauf(bank_tx_id);
