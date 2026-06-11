-- Per-task AI provider/model config + DeepSeek credentials.
-- Each AI task (recategorize, churner stage 1, churner stage 2) can pick its
-- own provider (ollama | deepseek) and model independently.

INSERT INTO app_config (key, value) VALUES
  -- DeepSeek
  ('deepseek.url',     '"https://api.deepseek.com"'),
  ('deepseek.api_key', '""'),

  -- Per-task provider + model.
  -- recategorize: lightweight classification, cheap+fast model is fine
  ('ai.recategorize.provider', '"ollama"'),
  ('ai.recategorize.model',    '"qwen2.5:14b"'),

  -- churner stage 1: classification + light reasoning
  ('ai.churner_stage1.provider', '"ollama"'),
  ('ai.churner_stage1.model',    '"qwen2.5:14b"'),

  -- churner stage 2: extracts canonical from web search hits (heavier reasoning helps)
  ('ai.churner_stage2.provider', '"ollama"'),
  ('ai.churner_stage2.model',    '"qwen2.5:14b"')
ON CONFLICT (key) DO NOTHING;
