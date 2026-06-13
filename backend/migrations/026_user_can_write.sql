-- Read-only accounts: an admin can grant a user view-only access (can_write=false)
-- so they can be shown the app without modifying/deleting data. Existing users and
-- admins keep full write access by default.
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_write BOOLEAN NOT NULL DEFAULT TRUE;
