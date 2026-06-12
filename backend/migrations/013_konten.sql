-- Multi-account / multi-user foundation.
--
-- konto = a payment account. GKK is shared (everyone sees it); personal
-- accounts belong to a user and are only visible to that user (+ super-admins).
CREATE TABLE IF NOT EXISTS konto (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  is_shared  BOOLEAN NOT NULL DEFAULT FALSE,
  user_id    INT REFERENCES users(id) ON DELETE SET NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the shared Gemeinkostenkonto (idempotent on re-run).
INSERT INTO konto (name, is_shared, sort_order)
SELECT 'GKK', TRUE, 0
WHERE NOT EXISTS (SELECT 1 FROM konto WHERE is_shared = TRUE);

-- Every receipt belongs to exactly one account, and has a source channel.
ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS konto_id INT REFERENCES konto(id);
ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS quelle TEXT NOT NULL DEFAULT 'zettel';
CREATE INDEX IF NOT EXISTS ix_einkauf_konto ON einkauf(konto_id);
CREATE INDEX IF NOT EXISTS ix_einkauf_quelle ON einkauf(quelle);

-- Backfill: all existing receipts were paid from GKK and came via Einkaufszettel.
UPDATE einkauf SET konto_id = (SELECT id FROM konto WHERE is_shared = TRUE ORDER BY id LIMIT 1)
WHERE konto_id IS NULL;

-- Visibility flag, separate from is_admin. Existing admins keep "sees all" so
-- nothing breaks; Martin can later turn his own off and promote a super-admin.
ALTER TABLE users ADD COLUMN IF NOT EXISTS sees_all_konten BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE users SET sees_all_konten = TRUE WHERE is_admin = TRUE;
