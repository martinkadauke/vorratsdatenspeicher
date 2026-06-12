-- Categories redesign support:
-- 1. artikel.category_path loses its FK so the category catalog can be
--    replaced wholesale while artikel keep their (now dangling) paths
--    until the next recategorize run rewrites them. Validation happens
--    in the app layer (recategorize whitelists against category.path).
-- 2. ai_task_log records every provider/model change per AI task so the
--    admin can see which model was active when.

ALTER TABLE artikel DROP CONSTRAINT IF EXISTS artikel_category_path_fkey;

CREATE TABLE IF NOT EXISTS ai_task_log (
  id          SERIAL PRIMARY KEY,
  task        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'auto_review'
  changed_by  INT REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_ai_task_log_task ON ai_task_log(task, changed_at DESC);
