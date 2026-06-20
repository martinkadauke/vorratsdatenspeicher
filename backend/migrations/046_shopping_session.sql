-- An active "Einkaufszettel" (shopping trip): freezes the current list with a date.
-- While one is open, list items are checked off (done) instead of deleted; on
-- "Einkauf abgeschlossen" the checked items are removed and the session closes.
-- At most one open session at a time (closed_at IS NULL).
CREATE TABLE IF NOT EXISTS shopping_session (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at  TIMESTAMPTZ,
  created_by TEXT
);
