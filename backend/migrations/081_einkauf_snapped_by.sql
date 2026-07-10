-- Who scanned/uploaded a receipt, as a HOUSEHOLD MEMBER (family_member) — the level
-- the user cares about (Lena vs Martin), not the login user. New PWA scans fill this
-- automatically from the logged-in user's linked member; the legacy PWA receipts (which
-- never persisted the scanner) can be set manually in the UI. ON DELETE SET NULL so
-- removing a member just drops the attribution, never a receipt.
ALTER TABLE einkauf ADD COLUMN IF NOT EXISTS snapped_by_member_id INTEGER REFERENCES family_member(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_einkauf_snapped_by ON einkauf(snapped_by_member_id) WHERE snapped_by_member_id IS NOT NULL;
