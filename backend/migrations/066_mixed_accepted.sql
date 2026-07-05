-- "Uneinheitliche Positionen": Nutzer kann die Diskrepanz akzeptieren (z.B.
-- Bananen: 46x kg + 4 Blank-Zeilen — Vereinheitlichen auf eine Zähl-Einheit
-- wäre falsch, der Estimator imputiert die Blanks ohnehin). Gesetzt = die
-- Zeile verschwindet dauerhaft aus der Mixed-Liste, Positionen bleiben roh.
ALTER TABLE canonical_meta ADD COLUMN IF NOT EXISTS mixed_accepted_at TIMESTAMP;
