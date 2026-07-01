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
  'ai.nlanalytics.provider': string;
  'ai.nlanalytics.model': string;
  'churner.enabled': boolean;
  'churner.cron': string;
  // Run a churn pass right after any receipt is OCR'd (debounced), so imports get
  // cleaned up immediately instead of waiting for the nightly run. Independent of
  // churner.enabled (which only gates the nightly cron).
  'churner.run_after_ocr': boolean;
  'churner.confidence': number;
  'churner.batch_size': number;
  // How aggressively the churner auto-applies AI canonical names:
  //  'guarded'        — only confident AND corroborated (web/snap), non-generic names auto-apply; rest → Prüfen
  //  'uncertain_only' — confident names auto-apply (legacy confidence-gate behavior)
  //  'all_new'        — never AI-auto-apply; every new name goes to Prüfen
  'churner.hitl_mode': string;
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
  'household.lat': number | null;
  'household.lon': number | null;
  'offers.radius_enabled': boolean;
  'offers.radius_km': number;
  'offers.extra_categories': string[];
  // supermarket info crawler (opening hours via OSM, nightly)
  'supermarket.enabled': boolean;
  'supermarket.cron': string;
  // bi-weekly AI model review (reviewer model is itself configurable → can be fully local)
  'model_review.enabled': boolean;
  'model_review.cron': string;
  // automatic e-mail receipt import (Path B): polls each user's configured IMAP
  // mailbox. The real gate is per-user (user_mailbox.enabled); this is the global
  // kill-switch + schedule. Inert when no mailbox is configured.
  'mailimport.enabled': boolean;
  'mailimport.cron': string;
  // web push (browser notifications) — VAPID keypair, generated + stored on first use
  'push.vapid_public': string;
  'push.vapid_private': string;
  'push.vapid_subject': string;
  // notification channel kill-switches (global) — offers & shared shopping list,
  // each per channel (email / push)
  'offers.email_enabled': boolean;
  'offers.push_enabled': boolean;
  'shopping.email_enabled': boolean;
  'shopping.push_enabled': boolean;
  // category granularity chosen in onboarding — steers the category-designer prompt
  'categories.detail': string;   // 'grob' | 'mittel' | 'fein'
  // first-run onboarding wizard completed (household-global; surfaced on /api/auth/me)
  'onboarding.done': boolean;
}

const DEFAULTS: AppConfig = {
  // No infra defaults: a fresh install has no local search/LLM host — the onboarding
  // wizard collects these. (Non-empty defaults would leak the author's LAN + look
  // "already configured".)
  'ollama.url': '',
  'ollama.model': 'qwen2.5:14b',
  'deepseek.url': 'https://api.deepseek.com',
  'deepseek.api_key': '',
  'anthropic.url': 'https://api.anthropic.com',
  'anthropic.api_key': '',
  'ai.ocr.provider': 'anthropic',
  'ai.ocr.model': 'claude-sonnet-5',
  'ai.categories_chat.provider': 'anthropic',
  'ai.categories_chat.model': 'claude-sonnet-5',
  'ai.recategorize.provider': 'ollama',
  'ai.recategorize.model': 'qwen2.5:14b',
  'ai.churner_stage1.provider': 'ollama',
  'ai.churner_stage1.model': 'qwen2.5:14b',
  'ai.churner_stage2.provider': 'ollama',
  'ai.churner_stage2.model': 'qwen2.5:14b',
  'ai.model_review.provider': 'ollama',
  'ai.model_review.model': 'qwen2.5:14b',
  // Analytics agent: strong reasoning matters for correct intent → defaults to Claude.
  'ai.nlanalytics.provider': 'anthropic',
  'ai.nlanalytics.model': 'claude-sonnet-5',
  'churner.enabled': true,
  'churner.cron': '0 3 * * *',
  'churner.run_after_ocr': true,
  'churner.confidence': 0.85,
  'churner.batch_size': 200,
  'churner.hitl_mode': 'guarded',
  'searxng.url': '',
  'app.default_lang': 'de',
  'app.base_url': '',
  'smtp.host': '',
  'smtp.port': 587,
  'smtp.secure': false,
  'smtp.user': '',
  'smtp.pass': '',
  'smtp.from': 'Vorratsdatenspeicher <vds@localhost>',
  'household.address': '',
  'household.lat': null,
  'household.lon': null,
  'offers.radius_enabled': false,
  'offers.radius_km': 10,
  'offers.extra_categories': [],
  'supermarket.enabled': true,
  'supermarket.cron': '0 4 * * *',
  'model_review.enabled': true,
  'model_review.cron': '0 5 1,15 * *', // ~bi-weekly: 1st & 15th, 05:00
  'mailimport.enabled': true,
  'mailimport.cron': '*/15 * * * *', // every 15 min — snappy "I forwarded it → it appears"
  'push.vapid_public': '',
  'push.vapid_private': '',
  'push.vapid_subject': '',
  'offers.email_enabled': true,
  'offers.push_enabled': true,
  'shopping.email_enabled': true,
  'shopping.push_enabled': true,
  'categories.detail': 'mittel',
  'onboarding.done': false,
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
