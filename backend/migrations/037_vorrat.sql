-- Vorrat rework: per-product opt-in, a manual stock override, and the iron
-- reserve. The live remaining estimate is computed in-app (no precomputed
-- vorrat_status), so nothing here stores the estimate itself.

-- Opt-in to stock tracking (set in the article master, like avoid/subscribe),
-- and the iron-reserve minimum (base unit) below which we warn.
ALTER TABLE canonical_meta ADD COLUMN IF NOT EXISTS track_vorrat BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE canonical_meta ADD COLUMN IF NOT EXISTS reserve_min  NUMERIC;

-- Manual "reality truth" override: how much we actually have, at a point in
-- time. Becomes the anchor the estimate counts down from.
CREATE TABLE IF NOT EXISTS vorrat_override (
  canonical_name TEXT PRIMARY KEY,
  menge          NUMERIC NOT NULL,                 -- in the product's base unit
  gesetzt_am     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Iron reserve: individual batches with their own expiry.
CREATE TABLE IF NOT EXISTS reserve_charge (
  id             SERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  gekauft_am     DATE,
  ablauf_am      DATE,
  menge          NUMERIC,
  einheit        TEXT,
  notiz          TEXT,
  added_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_reserve_charge_canon ON reserve_charge (canonical_name);
