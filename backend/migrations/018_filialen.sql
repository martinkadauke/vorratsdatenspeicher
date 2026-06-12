-- Filiale/Shop entity.
--
-- A chain and a branch ("filiale") come into existence the moment the first
-- Kassenbon for them is ingested. Online receipts (quelle='email') create
-- "shops" (Amazon, eBay …) instead of physical branches; cash receipts
-- (quelle='bar') need no store at all.
--
-- NOTE: a *legacy* `filiale` table (+ the unused einkauf.filiale_id column)
-- already exists in this DB from the original Einkaufszettelpuppe schema, with
-- a different shape. We do NOT touch it — this entity lives in its own table
-- `store_branch` and links via a fresh `einkauf.branch_id` column.
--
-- Because receipts are inserted from several paths (n8n Telegram ingestion,
-- in-app re-OCR, manual edits), the create-and-link logic lives in a DB
-- trigger so EVERY path is covered without touching n8n.

-- ── store-name normalization (mirrors normalizeStore() in routes/stores.ts) ──
-- "LIDL", "Lidl GmbH" → "lidl". Used as the chain grouping key + store_meta key.
CREATE OR REPLACE FUNCTION normalize_store(raw TEXT) RETURNS TEXT AS $$
DECLARE
  s TEXT;
BEGIN
  s := lower(coalesce(raw, ''));
  s := regexp_replace(s, 'gmbh|kg|ag|co\.?|&|service', '', 'g');
  s := regexp_replace(s, '[^a-z0-9äöüß]+', ' ', 'g');
  s := btrim(s);
  RETURN split_part(s, ' ', 1);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ── the entity ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store_branch (
  id             SERIAL PRIMARY KEY,
  chain_key      TEXT NOT NULL,                        -- normalized chain ("lidl")
  name           TEXT NOT NULL,                        -- raw branch/shop name as seen on the receipt
  kind           TEXT NOT NULL DEFAULT 'filiale',      -- 'filiale' (physical, Kassenbon) | 'shop' (online, Email)
  -- profile fields (editor + automation land in later schübe — kept nullable here)
  address        TEXT,
  lat            NUMERIC,
  lon            NUMERIC,
  opening_hours  JSONB,                                -- weekly hours, cron-refreshed (WIP)
  prospectus_url TEXT,                                 -- latest offer prospectus (WIP)
  warengruppen   JSONB,                                -- tiered ordering: [[catA,catB],[catC]] (WIP editor)
  subscribed     BOOLEAN NOT NULL DEFAULT FALSE,       -- offer subscription (WIP)
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_store_branch_kind_name ON store_branch(kind, name);
CREATE INDEX IF NOT EXISTS ix_store_branch_chain ON store_branch(chain_key);

-- ── einkauf → store_branch link (fresh column, independent of legacy filiale_id) ──
ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS branch_id INT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_einkauf_branch') THEN
    ALTER TABLE einkauf
      ADD CONSTRAINT fk_einkauf_branch
      FOREIGN KEY (branch_id) REFERENCES store_branch(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ix_einkauf_branch ON einkauf(branch_id);

-- ── auto-create + link trigger ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION link_store_branch() RETURNS trigger AS $$
DECLARE
  v_kind TEXT;
  v_name TEXT;
  v_id   INT;
BEGIN
  v_name := NULLIF(btrim(NEW.roh_ladenname), '');

  -- cash receipts need no store; nameless receipts can't create one
  IF NEW.quelle = 'bar' OR v_name IS NULL THEN
    NEW.branch_id := NULL;
    RETURN NEW;
  END IF;

  v_kind := CASE WHEN NEW.quelle = 'email' THEN 'shop' ELSE 'filiale' END;

  SELECT id INTO v_id FROM store_branch WHERE kind = v_kind AND name = v_name;
  IF v_id IS NULL THEN
    INSERT INTO store_branch (chain_key, name, kind)
    VALUES (normalize_store(v_name), v_name, v_kind)
    ON CONFLICT (kind, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_id;
  END IF;

  NEW.branch_id := v_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_link_store_branch ON einkauf;
CREATE TRIGGER trg_link_store_branch
  BEFORE INSERT OR UPDATE OF roh_ladenname, quelle ON einkauf
  FOR EACH ROW EXECUTE FUNCTION link_store_branch();

-- ── backfill existing receipts ────────────────────────────────────────────
-- Touch roh_ladenname so the BEFORE-UPDATE trigger creates every chain/branch
-- from the receipts already in the DB and links each einkauf to it.
UPDATE einkauf SET roh_ladenname = roh_ladenname WHERE roh_ladenname IS NOT NULL;
