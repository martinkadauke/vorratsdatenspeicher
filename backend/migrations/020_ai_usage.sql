-- Token usage log: one row per AI call, so the admin can see consumption per
-- provider/model/task over time and judge when to top up credit.
CREATE TABLE IF NOT EXISTS ai_usage (
  id            SERIAL PRIMARY KEY,
  task          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ai_usage_created  ON ai_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ai_usage_provider ON ai_usage(provider, created_at DESC);
