-- Multi-link: a bank debit can point to its receipt (many bank_tx -> one einkauf), so
-- Amazon-style split shipments — one order/invoice charged as several bank debits that
-- SUM to the invoice total — can all be reconciled against the single receipt.
--
-- The existing 1:1 link stays intact: einkauf.bank_tx_id = the "primary" debit of a
-- receipt (drives the receipt-detail bank badge + the fixed-cost evidence chain). The
-- NEW bank_tx.einkauf_id carries every debit that belongs to a receipt (primary AND
-- siblings). Reconciliation status reads BOTH directions
-- (einkauf.bank_tx_id = bt.id  OR  bt.einkauf_id = e.id), so no backfill is needed —
-- existing links keep working via einkauf.bank_tx_id.
ALTER TABLE bank_tx ADD COLUMN IF NOT EXISTS einkauf_id INTEGER REFERENCES einkauf(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_bank_tx_einkauf ON bank_tx(einkauf_id) WHERE einkauf_id IS NOT NULL;
