-- Path B: automatic e-mail receipt import.
-- Each user connects their OWN IMAP mailbox (multi-tenant by design — no shared
-- family inbox, so this works unchanged when VDS is self-hosted by strangers).
-- A background poll (node-cron + pg advisory lock) pulls new messages, runs the
-- existing OCR/extraction pipeline, and files them as receipts attributed to that
-- user. The IMAP password is stored ENCRYPTED at rest (AES-256-GCM, key from the
-- MAILBOX_ENC_KEY env, falling back to JWT_SECRET).
CREATE TABLE IF NOT EXISTS user_mailbox (
  user_id        INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  imap_host      TEXT    NOT NULL,
  imap_port      INT     NOT NULL DEFAULT 993,
  imap_secure    BOOLEAN NOT NULL DEFAULT TRUE,    -- implicit TLS (993); STARTTLS when false (143)
  imap_user      TEXT    NOT NULL,
  imap_pass_enc  TEXT    NOT NULL,                 -- AES-256-GCM: "iv:tag:ciphertext" (base64 parts)
  folder         TEXT    NOT NULL DEFAULT 'INBOX', -- dedicate a folder/label to forwarded invoices
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  make_private   BOOLEAN NOT NULL DEFAULT TRUE,    -- imported receipts private to this user by default (personal mail → personal receipts)
  last_uid       BIGINT  NOT NULL DEFAULT 0,       -- highest IMAP UID already processed (per UIDVALIDITY)
  uid_validity   BIGINT,                           -- reset last_uid if the server's UIDVALIDITY changes
  last_poll_at   TIMESTAMP,
  last_ok_at     TIMESTAMP,
  last_error     TEXT,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

-- Dedup ledger: never import the same message twice (survives UID resets), and
-- keep a trail of what each message produced (imported / skipped / failed).
CREATE TABLE IF NOT EXISTS imported_email (
  id          SERIAL PRIMARY KEY,
  user_id     INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  einkauf_id  INT  REFERENCES einkauf(id) ON DELETE SET NULL,
  subject     TEXT,
  status      TEXT NOT NULL DEFAULT 'imported',    -- 'imported' | 'skipped' | 'failed'
  reason      TEXT,
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS ix_imported_email_user ON imported_email(user_id);
