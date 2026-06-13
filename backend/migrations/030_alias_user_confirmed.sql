-- Mark OCR→canonical aliases that came from a *user* correction (vs. the AI/matcher).
-- User-confirmed aliases are authoritative: the AI may not overwrite them, and they
-- are fed back to the LLM as a strong prior for similar OCR text.
ALTER TABLE canonical_alias ADD COLUMN IF NOT EXISTS user_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS ix_canonical_alias_userconf ON canonical_alias(user_confirmed) WHERE user_confirmed;
