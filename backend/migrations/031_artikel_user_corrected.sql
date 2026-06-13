-- Marks an artikel whose canonical name was set by a user — directly, or inherited
-- from a user-confirmed alias. Global (per artikel), so every user with access to the
-- artikel sees the "Nutzerkorrigiert" badge.
ALTER TABLE artikel ADD COLUMN IF NOT EXISTS user_corrected BOOLEAN NOT NULL DEFAULT FALSE;
