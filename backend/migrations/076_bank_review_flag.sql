-- 076_bank_review_flag.sql
-- Personal "needs a closer look" marker on a bank statement line. Set by the
-- user via long-press in the Auszüge list; purely a private review aid, no
-- effect on matching or totals.
ALTER TABLE bank_tx ADD COLUMN IF NOT EXISTS review_flag BOOLEAN NOT NULL DEFAULT FALSE;
