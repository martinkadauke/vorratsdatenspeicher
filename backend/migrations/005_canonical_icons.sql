CREATE TABLE IF NOT EXISTS canonical_meta (
  canonical_name TEXT PRIMARY KEY,
  icon_url       TEXT,
  source         TEXT,
  updated_at     TIMESTAMP DEFAULT NOW(),
  updated_by     INT
);
