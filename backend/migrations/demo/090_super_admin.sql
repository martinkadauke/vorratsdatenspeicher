-- 090_super_admin.sql — platform super-admin flag (distinct from household is_admin and
-- the intra-household sees_all_konten). The platform super-admin (Martin) sees across all
-- households and owns all AI/API-key/provider config; TOTP 2FA is added in a later phase.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;
