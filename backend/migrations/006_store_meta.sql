CREATE TABLE IF NOT EXISTS store_meta (
  store_key  TEXT PRIMARY KEY,  -- normalized first-word key, e.g. "lidl"
  icon_url   TEXT,
  source     TEXT,
  updated_at TIMESTAMP DEFAULT NOW(),
  updated_by INT
);
