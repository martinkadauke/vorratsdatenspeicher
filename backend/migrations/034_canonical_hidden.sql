-- Let the user hide individual products from the article list (e.g. one-off
-- items they don't want to track). Meta/* is hidden by the UI separately.
ALTER TABLE canonical_meta ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
