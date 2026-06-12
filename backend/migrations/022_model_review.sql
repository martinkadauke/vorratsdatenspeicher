-- Bi-weekly AI model review proposals. The reviewer LLM suggests, per AI task,
-- whether a newer/better model exists; the super-admin approves or rejects ALL
-- via tokenized links in an email. No silent auto-switching.
CREATE TABLE IF NOT EXISTS model_review (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending | applied | rejected
  proposals  JSONB NOT NULL,                   -- [{task, provider, current_model, suggested_model, reason}]
  token      TEXT NOT NULL,                     -- secret for the approve/reject links
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_model_review_status ON model_review(status, created_at DESC);
