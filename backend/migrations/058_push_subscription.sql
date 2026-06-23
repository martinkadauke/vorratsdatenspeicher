-- Browser Web Push subscriptions (one row per device/browser per user).
CREATE TABLE IF NOT EXISTS push_subscription (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_push_sub_user ON push_subscription(user_id);
