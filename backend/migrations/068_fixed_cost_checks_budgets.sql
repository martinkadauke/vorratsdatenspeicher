-- Finanzen-Monatsansicht: Fixkosten-Gegenprüfung pro Monat + variable Budgets.

-- Fixkosten: Matching-Metadaten.
--  expect_receipt = FALSE → Position hat nie einen Beleg (Miete per Dauerauftrag)
--    und zählt in der Monats-Checkliste automatisch als ok.
--  match_merchant = Händlername fürs Beleg-Matching ("Internet" ↔ "Telekom");
--    wird beim ersten manuellen Zuordnen automatisch GELERNT, editierbar.
ALTER TABLE fixed_cost ADD COLUMN IF NOT EXISTS expect_receipt BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE fixed_cost ADD COLUMN IF NOT EXISTS match_merchant TEXT;

-- Eine Prüfzeile pro Fixkostenposition und Monat. Evidenz heute = ein Beleg
-- (einkauf_id); das Modell ist bewusst evidenz-erweiterbar — später kommt eine
-- bank_tx_id-Spalte für comdirect-CSV-Transaktionen dazu (Bank ↔ Beleg ↔
-- Fixkosten als drei Prüfkanten). status: 'confirmed' (Evidenz zugeordnet oder
-- ohne Beleg bestätigt) | 'skipped' ("diesen Monat ok" ohne Evidenz).
CREATE TABLE IF NOT EXISTS fixed_cost_check (
  id             SERIAL PRIMARY KEY,
  fixed_cost_id  INT NOT NULL REFERENCES fixed_cost(id) ON DELETE CASCADE,
  month          DATE NOT NULL,                -- immer der Monatserste
  status         TEXT NOT NULL,                -- 'confirmed' | 'skipped'
  einkauf_id     INT REFERENCES einkauf(id) ON DELETE SET NULL,
  amount         NUMERIC(12,2),                -- Belegbetrag zum Prüfzeitpunkt (Delta-Anzeige)
  decided_by     INT REFERENCES users(id) ON DELETE SET NULL,
  decided_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fixed_cost_id, month)
);
CREATE INDEX IF NOT EXISTS ix_fcc_einkauf ON fixed_cost_check(einkauf_id);

-- Variable Kostenziele als CUSTOM-GRUPPEN: ein Budget bündelt 1..n Waren-
-- kategorien (Präfix-Match auf artikel.category_path) unter einem freien Label
-- ("Essen" = Lebensmittel + Restaurant). konto_id NULL = ganzer Haushalt,
-- gesetzt = nur Belege dieses Kontos (Person).
CREATE TABLE IF NOT EXISTS budget (
  id             SERIAL PRIMARY KEY,
  label          TEXT NOT NULL,
  monthly_target NUMERIC(12,2) NOT NULL,
  konto_id       INT REFERENCES konto(id) ON DELETE SET NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS budget_category (
  budget_id      INT NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  category_path  TEXT NOT NULL,
  PRIMARY KEY (budget_id, category_path)
);

GRANT SELECT ON fixed_cost_check, budget, budget_category TO analytics;
