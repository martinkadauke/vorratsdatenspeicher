-- Drop-folder invoice importer: dedup ledger keyed by the file's CONTENT hash, so
-- a file placed in the watched folder is imported exactly once — even if renamed,
-- copied, or the folder is re-scanned every few minutes. Mirrors imported_email
-- (the e-mail importer's ledger). Non-destructive: the user's original files stay
-- in the drop folder; this table is what prevents re-importing them.
CREATE TABLE IF NOT EXISTS imported_file (
  id          SERIAL PRIMARY KEY,
  file_hash   TEXT NOT NULL UNIQUE,               -- sha256 of the file bytes
  source_name TEXT,                               -- original filename in the drop folder
  einkauf_id  INT REFERENCES einkauf(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'imported',   -- 'imported' | 'failed'
  reason      TEXT,                               -- failure detail (OCR error, etc.)
  attempts    INT NOT NULL DEFAULT 1,             -- OCR attempts; give up after a few
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);
