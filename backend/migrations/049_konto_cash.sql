-- Dedicated cash ("Bargeld") accounts, one per user-linked personal account, so a
-- cash payment can be attributed to whose wallet it came from — separately from
-- that person's card/bank account. Flagged is_cash so the "neu anlegen" picker can
-- show cash accounts for Barzahlung and the regular ones for card. The rows
-- themselves are created by an idempotent boot seed (ensureCashKonten) so it stays
-- env-portable (user ids differ per environment).
ALTER TABLE konto ADD COLUMN IF NOT EXISTS is_cash BOOLEAN NOT NULL DEFAULT FALSE;
