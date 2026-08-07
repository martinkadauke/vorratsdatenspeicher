-- Passkeys / WebAuthn (FIDO2). Phishing-resistant, passwordless login — the hardening for the
-- upcoming public-tunnel (Electron desktop + Tailscale Funnel) exposure, and useful to every
-- self-hoster behind their own HTTPS proxy too. VDS stays the sole identity provider: we store
-- only the PUBLIC key; the private key never leaves the user's device (Face ID / fingerprint,
-- synced via iCloud Keychain / Google Password Manager).
--
-- Like user_onboarding / push_subscription / notification_pref, both tables are keyed by user_id
-- with NO household_id, so they are RLS-exempt on the demo and reach vds_app via the migration-089
-- default-privileges grant. Passwords stay as the recovery path (auth_token reset), so passkeys
-- are purely additive.

-- A registered authenticator (one per device/passkey). credential_id is the base64url id the
-- browser returns; public_key holds the raw COSE public-key bytes; counter is the signature
-- counter for clone detection.
CREATE TABLE IF NOT EXISTS webauthn_credential (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT        NOT NULL UNIQUE,
  public_key    BYTEA       NOT NULL,
  counter       BIGINT      NOT NULL DEFAULT 0,
  transports    TEXT[],
  device_name   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_webauthn_credential_user ON webauthn_credential(user_id);

-- Short-lived server-side challenges (consume-once via DELETE ... RETURNING → no replay). user_id
-- is set for registration (the logged-in user) and NULL for usernameless login (the credential
-- itself identifies the user on verify). A row older than a few minutes is treated as expired.
CREATE TABLE IF NOT EXISTS webauthn_challenge (
  id         TEXT        PRIMARY KEY,
  challenge  TEXT        NOT NULL,
  user_id    INTEGER     REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT        NOT NULL,   -- 'register' | 'authenticate'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
