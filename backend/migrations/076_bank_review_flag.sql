-- 076_bank_review_flag.sql
-- "Needs a closer look" marker on a bank statement line, set via long-press in
-- the Auszüge list. SHARED household state (bank_tx is shared finance data, like
-- income/fixed_cost) — every household member sees and can toggle it. Pure review
-- aid, no effect on matching or totals. (Make per-user only if a member ever wants
-- a private review list.)
ALTER TABLE bank_tx ADD COLUMN IF NOT EXISTS review_flag BOOLEAN NOT NULL DEFAULT FALSE;
