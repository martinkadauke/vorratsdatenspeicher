-- Richer shopping list: free-text items (never bought), a quantity, and an
-- expected price. Supersedes the canonical-only `einkaufsliste` (kept in place
-- as a safety net; the few existing rows are migrated over).
CREATE TABLE IF NOT EXISTS einkaufsliste_item (
  id             SERIAL PRIMARY KEY,
  canonical_name TEXT,                            -- linked product if known; NULL = free-text never-bought item
  title          TEXT NOT NULL,                   -- display label
  menge          NUMERIC,
  einheit        TEXT,
  source         TEXT NOT NULL DEFAULT 'manual',  -- manual | suggested
  done           BOOLEAN NOT NULL DEFAULT FALSE,
  priority       INT NOT NULL DEFAULT 0,
  added_by       TEXT,
  added_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- A known product appears at most once; free-text items (canonical NULL) may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS ux_einkaufsliste_item_canon
  ON einkaufsliste_item (canonical_name) WHERE canonical_name IS NOT NULL;

-- One-time migration of any legacy rows.
INSERT INTO einkaufsliste_item (canonical_name, title, source, priority, added_by, added_at)
SELECT canonical_name, canonical_name,
       CASE WHEN added_by = 'model' THEN 'suggested' ELSE 'manual' END,
       COALESCE(priority, 0), added_by, COALESCE(added_at, NOW())
FROM einkaufsliste
ON CONFLICT (canonical_name) WHERE canonical_name IS NOT NULL DO NOTHING;
