import sql from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
export const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? 'dev-internal-secret';
export const PORT = parseInt(process.env.PORT ?? '3000', 10);

export interface AppConfig {
  'ollama.url': string;
  'ollama.model': string;
  'deepseek.url': string;
  'deepseek.api_key': string;
  'anthropic.url': string;
  'anthropic.api_key': string;
  'ai.ocr.provider': string;
  'ai.ocr.model': string;
  'ai.categories_chat.provider': string;
  'ai.categories_chat.model': string;
  'ai.recategorize.provider': string;
  'ai.recategorize.model': string;
  'ai.churner_stage1.provider': string;
  'ai.churner_stage1.model': string;
  'ai.churner_stage2.provider': string;
  'ai.churner_stage2.model': string;
  'ai.model_review.provider': string;
  'ai.model_review.model': string;
  'churner.enabled': boolean;
  'churner.cron': string;
  'churner.confidence': number;
  'churner.batch_size': number;
  'searxng.url': string;
  'app.default_lang': string;
  'app.base_url': string;
  'smtp.host': string;
  'smtp.port': number;
  'smtp.secure': boolean;
  'smtp.user': string;
  'smtp.pass': string;
  'smtp.from': string;
  // household + offer-radius (the geo prospectus search itself is still WIP)
  'household.address': string;
  'offers.radius_enabled': boolean;
  'offers.radius_km': number;
  'offers.extra_categories': string[];
  // supermarket info crawler (opening hours via OSM, nightly)
  'supermarket.enabled': boolean;
  'supermarket.cron': string;
  // bi-weekly AI model review (reviewer model is itself configurable → can be fully local)
  'model_review.enabled': boolean;
  'model_review.cron': string;
}

const DEFAULTS: AppConfig = {
  'ollama.url': 'http://192.168.1.238:11434',
  'ollama.model': 'qwen2.5:14b',
  'deepseek.url': 'https://api.deepseek.com',
  'deepseek.api_key': '',
  'anthropic.url': 'https://api.anthropic.com',
  'anthropic.api_key': '',
  'ai.ocr.provider': 'anthropic',
  'ai.ocr.model': 'claude-sonnet-4-5',
  'ai.categories_chat.provider': 'anthropic',
  'ai.categories_chat.model': 'claude-sonnet-4-5',
  'ai.recategorize.provider': 'ollama',
  'ai.recategorize.model': 'qwen2.5:14b',
  'ai.churner_stage1.provider': 'ollama',
  'ai.churner_stage1.model': 'qwen2.5:14b',
  'ai.churner_stage2.provider': 'ollama',
  'ai.churner_stage2.model': 'qwen2.5:14b',
  'ai.model_review.provider': 'ollama',
  'ai.model_review.model': 'qwen2.5:14b',
  'churner.enabled': true,
  'churner.cron': '0 3 * * *',
  'churner.confidence': 0.85,
  'churner.batch_size': 200,
  'searxng.url': 'http://192.168.1.238:8089',
  'app.default_lang': 'de',
  'app.base_url': 'http://192.168.1.238:8766',
  'smtp.host': '',
  'smtp.port': 587,
  'smtp.secure': false,
  'smtp.user': '',
  'smtp.pass': '',
  'smtp.from': 'Vorratsdatenspeicher <vds@localhost>',
  'household.address': '',
  'offers.radius_enabled': false,
  'offers.radius_km': 10,
  'offers.extra_categories': [],
  'supermarket.enabled': true,
  'supermarket.cron': '0 4 * * *',
  'model_review.enabled': true,
  'model_review.cron': '0 5 1,15 * *', // ~bi-weekly: 1st & 15th, 05:00
};

export async function getConfig<K extends keyof AppConfig>(key: K): Promise<AppConfig[K]> {
  const rows = await sql`SELECT value FROM app_config WHERE key = ${key}`;
  if (!rows.length) return DEFAULTS[key];
  return rows[0].value as AppConfig[K];
}

export async function getAllConfig(): Promise<Record<string, unknown>> {
  const rows = await sql`SELECT key, value FROM app_config ORDER BY key`;
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) out[r.key as string] = r.value;
  return out;
}

export async function setConfig(key: string, value: unknown, userId?: number): Promise<void> {
  await sql`
    INSERT INTO app_config (key, value, updated_at, updated_by)
    VALUES (${key}, ${sql.json(value as never)}, NOW(), ${userId ?? null})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by
  `;
}
