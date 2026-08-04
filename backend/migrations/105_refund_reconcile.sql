-- Refund reconciliation (v1.0.6): persist a REFUND E-MAIL so it can be reviewed in the
-- import log BEFORE booking and later re-opened from the receipt via a paperclip.
--
-- WHY a new table (not email_message): email_message is PK einkauf_id = exactly ONE row
-- per receipt = the ORIGINAL purchase mail. A receipt can accrue SEVERAL refund mails over
-- time (partial returns, later price adjustments), and a detected refund mail exists
-- (imported_email.status = 'refund_suggested') BEFORE the user has picked a receipt — so
-- einkauf_id is NULLABLE here and set on confirm. imported_email itself stores no body
-- (mig 053), and the mail may leave the mailbox, so the body/PDF is captured at detect time.
-- Bank-credit- and manually-initiated refunds carry no mail and simply create no row.
--
-- The refund POSITION needs NO new schema: it reuses artikel.is_refund +
-- refund_for_artikel_id (mig 104). A partial return is booked by SPLITTING the combined
-- position into single-unit rows and booking a FULL refund against the returned unit, so
-- the existing all-or-nothing excludeRefunded() stays correct and untouched, and the gross
-- einkauf.gesamt_betrag stays the bank-reconciliation anchor.
CREATE TABLE IF NOT EXISTS refund_email (
  id                SERIAL PRIMARY KEY,
  imported_email_id INT REFERENCES imported_email(id) ON DELETE CASCADE, -- source ledger row (mail-originated); NULL if attached by hand
  einkauf_id        INT REFERENCES einkauf(id) ON DELETE CASCADE,        -- the receipt it belongs to; NULL until the refund is confirmed
  refund_artikel_id INT REFERENCES artikel(id) ON DELETE SET NULL,       -- the (primary) negative refund position it justifies
  -- The structured refund the mail represents (parsed once at detect time, so opening the
  -- reconciliation needs no second LLM call). amount is the refunded EUR the mail states.
  amount            NUMERIC(10,2),
  merchant          TEXT,
  item              TEXT,        -- refunded item text ("Ventilator XY 40cm"), for position matching
  order_ref         TEXT,        -- order / reference number, generic across vendors
  from_addr         TEXT,
  subject           TEXT,
  sent_at           TIMESTAMPTZ,
  html              TEXT,        -- sanitised at render time (same scrubber as email_message)
  body_text         TEXT,
  pdf_pfad          TEXT,        -- /receipts/<uuid>.pdf if the refund mail carried a PDF attachment
  created_at        TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_refund_email_einkauf  ON refund_email(einkauf_id)        WHERE einkauf_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_refund_email_imported ON refund_email(imported_email_id) WHERE imported_email_id IS NOT NULL;
