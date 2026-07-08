-- Bank statement transactions as a THIRD evidence source for fixed-cost checks
-- (alongside e-mail/upload invoices). A comdirect-style CSV import (coming next)
-- fills this table; the finances matching then offers a bank transaction as
-- evidence exactly like a receipt. Kept generic so any bank's export can map onto
-- it. NOT (yet) folded into v_transactions — avoids double-counting receipts.
CREATE TABLE IF NOT EXISTS bank_tx (
  id            SERIAL PRIMARY KEY,
  konto_id      INT REFERENCES konto(id),
  booking_date  DATE NOT NULL,                -- Buchungstag
  value_date    DATE,                         -- Wertstellung / Valuta
  amount        NUMERIC(12,2) NOT NULL,       -- SIGNED: < 0 = Belastung (expense), > 0 = Gutschrift
  counterparty  TEXT,                         -- Empfänger / Auftraggeber
  description   TEXT,                         -- Buchungstext / Vorgang
  raw           TEXT,                         -- original CSV line (audit / re-parse)
  import_batch  TEXT,                         -- which upload produced this row
  imported_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Dedup: re-importing an overlapping export must not duplicate rows.
  UNIQUE (konto_id, booking_date, amount, description)
);
CREATE INDEX IF NOT EXISTS ix_bank_tx_date ON bank_tx(booking_date);
CREATE INDEX IF NOT EXISTS ix_bank_tx_konto ON bank_tx(konto_id);

-- A fixed-cost check can now be backed by a bank transaction instead of (or as
-- well as) a receipt. Both nullable → a check may still be "confirmed without
-- evidence" (skip) or carry either evidence kind.
ALTER TABLE fixed_cost_check ADD COLUMN IF NOT EXISTS bank_tx_id INT REFERENCES bank_tx(id) ON DELETE SET NULL;
