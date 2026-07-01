-- Multiple shopping lists, each with an optional store-type. "Vorschläge holen" is
-- scoped by the list's type × the product's HISTORICAL purchase store-types: a product
-- is only suggested on a Drogerie list if it was actually bought at a drugstore before
-- (Waschmittel bought at dm+rewe → appears on Drogerie AND Supermarkt; Bananen never
-- bought at a Baumarkt → never suggested there). See routes/pantry.ts suggest.

-- ── 1. store-type per chain (on store_meta, keyed by chain_key = store_key) ──
ALTER TABLE store_meta ADD COLUMN IF NOT EXISTS store_type TEXT;

-- Seed well-known German chains. Idempotent AND non-clobbering: a manual override in
-- the Läden UI (a non-NULL store_type already set) is kept; only NULL/new rows are seeded.
INSERT INTO store_meta (store_key, store_type) VALUES
  ('rewe','Supermarkt'),('edeka','Supermarkt'),('aldi','Supermarkt'),('lidl','Supermarkt'),
  ('penny','Supermarkt'),('kaufland','Supermarkt'),('netto','Supermarkt'),('nahkauf','Supermarkt'),
  ('tegut','Supermarkt'),('denns','Supermarkt'),('denn','Supermarkt'),('alnatura','Supermarkt'),('real','Supermarkt'),
  ('dm','Drogerie'),('rossmann','Drogerie'),('müller','Drogerie'),('mueller','Drogerie'),('budni','Drogerie'),
  ('obi','Baumarkt'),('bauhaus','Baumarkt'),('hornbach','Baumarkt'),('toom','Baumarkt'),('hagebau','Baumarkt'),
  ('fressnapf','Tierbedarf'),('zooplus','Tierbedarf'),
  ('apotheke','Apotheke'),
  ('bäckerei','Bäckerei'),('baeckerei','Bäckerei'),
  ('amazon','Online'),('ebay','Online')
ON CONFLICT (store_key) DO UPDATE
  SET store_type = COALESCE(store_meta.store_type, EXCLUDED.store_type);

-- ── 2. the list entity ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopping_list (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  store_type  TEXT,                          -- NULL = untyped: suggest everything (legacy behaviour)
  sort        INT NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default list (only if none exists) — the existing single global list migrates onto it.
INSERT INTO shopping_list (name, sort)
  SELECT 'Einkaufsliste', 0 WHERE NOT EXISTS (SELECT 1 FROM shopping_list);

-- ── 3. list_id on items (per-list uniqueness: a product may sit on several lists) ──
ALTER TABLE einkaufsliste_item ADD COLUMN IF NOT EXISTS list_id INT;
UPDATE einkaufsliste_item SET list_id = (SELECT MIN(id) FROM shopping_list) WHERE list_id IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_eli_list') THEN
    ALTER TABLE einkaufsliste_item
      ADD CONSTRAINT fk_eli_list FOREIGN KEY (list_id) REFERENCES shopping_list(id) ON DELETE CASCADE;
  END IF;
END $$;
DROP INDEX IF EXISTS ux_einkaufsliste_item_canon;                 -- was global unique(canonical)
CREATE UNIQUE INDEX IF NOT EXISTS ux_eli_list_canon
  ON einkaufsliste_item (list_id, canonical_name) WHERE canonical_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_eli_list ON einkaufsliste_item (list_id);

-- ── 4. per-list shopping session (at most one open trip PER list) ──
ALTER TABLE shopping_session ADD COLUMN IF NOT EXISTS list_id INT;
UPDATE shopping_session SET list_id = (SELECT MIN(id) FROM shopping_list) WHERE list_id IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_session_list') THEN
    ALTER TABLE shopping_session
      ADD CONSTRAINT fk_session_list FOREIGN KEY (list_id) REFERENCES shopping_list(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_session_list ON shopping_session (list_id);
