-- Bank-CSV Phase 3: link a bank GUTSCHRIFT (credit, amount > 0) to an actual income
-- entry (pay slip / recorded income) — the mirror of einkauf.bank_tx_id for debits.
ALTER TABLE income ADD COLUMN IF NOT EXISTS bank_tx_id INT REFERENCES bank_tx(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_income_bank_tx ON income(bank_tx_id);
