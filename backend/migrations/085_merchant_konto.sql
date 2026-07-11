-- Learn which ACCOUNT a biller is paid from, so a recurring invoice self-files to the
-- right account instead of inheriting the mailbox owner's account.
--
-- Motivation: an e-mail invoice arrives in a personal mailbox and inherits that person's
-- account, but the bill may be paid from a different account (e.g. an ISP bill that lands
-- in Martin's inbox but is direct-debited from the shared household account). The paying
-- account is the one the bank statement lives on — so reconciling an invoice canonicalises
-- its account, and we remember biller -> account for next time. Keyed on the normalised
-- merchant string; global (single-household today — add a household_id when that changes).
CREATE TABLE IF NOT EXISTS merchant_konto (
  merchant_key TEXT PRIMARY KEY,
  konto_id     INT NOT NULL REFERENCES konto(id) ON DELETE CASCADE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill the marry/align gap (general, not Telekom-specific): a fixed-cost check that
-- reconciled BOTH an invoice and a bank statement stored them as two separate legs but
-- never married the invoice to the statement, so the receipt showed no bank and sat on
-- the wrong account. Marry them (einkauf.bank_tx_id) and move the invoice to the account
-- that actually paid it (the statement's account). Idempotent (only unmarried rows).
-- DISTINCT ON keeps it deterministic if an invoice is (rarely) used on two checks: the
-- earliest check month wins.
UPDATE einkauf e
   SET bank_tx_id = sub.bank_tx_id,
       konto_id   = sub.konto_id
  FROM (
    SELECT DISTINCT ON (c.einkauf_id) c.einkauf_id, c.bank_tx_id, bt.konto_id
    FROM fixed_cost_check c
    JOIN bank_tx bt ON bt.id = c.bank_tx_id
    WHERE c.bank_tx_id IS NOT NULL
    ORDER BY c.einkauf_id, c.month
  ) sub
 WHERE sub.einkauf_id = e.id
   AND e.bank_tx_id IS NULL;
