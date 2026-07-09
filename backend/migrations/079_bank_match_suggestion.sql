-- 079_bank_match_suggestion.sql
-- Pending AI ("creative") match proposals for still-open bank statement lines.
-- The deterministic matcher writes real links directly; the AI matcher only
-- PROPOSES here (marked ⭐ in the UI) and a human must approve — approving turns
-- the proposal into the real link (einkauf/income/fixed_cost_check) and deletes
-- the row; dismissing just deletes it. At most one pending proposal per bank line.
CREATE TABLE IF NOT EXISTS bank_match_suggestion (
  id            SERIAL PRIMARY KEY,
  bank_tx_id    INT NOT NULL UNIQUE REFERENCES bank_tx(id) ON DELETE CASCADE,
  target_kind   TEXT NOT NULL,                                    -- 'receipt' | 'income' | 'fixed'
  einkauf_id    INT REFERENCES einkauf(id) ON DELETE CASCADE,
  income_id     INT REFERENCES income(id) ON DELETE CASCADE,
  fixed_cost_id INT REFERENCES fixed_cost(id) ON DELETE CASCADE,
  confidence    REAL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
