-- Email + invite/reset tokens

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS auth_token (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                -- 'invite' | 'reset'
  token      TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  used_at    TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_auth_token_token ON auth_token(token);

INSERT INTO app_config (key, value) VALUES
  ('smtp.host',    '""'),
  ('smtp.port',    '587'),
  ('smtp.secure',  'false'),
  ('smtp.user',    '""'),
  ('smtp.pass',    '""'),
  ('smtp.from',    '"Vorratsdatenspeicher <vds@localhost>"'),
  ('app.base_url', '"http://192.168.1.238:8766"')
ON CONFLICT (key) DO NOTHING;
