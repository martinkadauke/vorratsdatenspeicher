import sql from './db.js';
import { desktopBaseUrl } from './desktop.js';

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
  'openai.url': string;
  'openai.api_key': string;
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
  'ai.bankmatch.provider': string;
  'ai.bankmatch.model': string;
  'ai.statsask.provider': string;
  'ai.statsask.model': string;
  'ai.csvmapping.provider': string;
  'ai.csvmapping.model': string;
  'ai.mailreinterpret.provider': string;
  'ai.mailreinterpret.model': string;
  // Hard ceiling for an income booked from a mail via the reinterpret retry — a safety cap
  // against an attacker-authored mail (or a mis-read) writing an absurd amount to the books.
  'income.max_mail_amount': number;
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
  // Passkeys/WebAuthn: RP-ID (hostname, no scheme/port) + expected origin. Empty = derive from
  // app.base_url. Set explicitly on the Electron+Tunnel build to the stable Tailscale-Funnel host.
  'webauthn.rp_id': string;
  'webauthn.origin': string;
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
  'demo_sweep.enabled': boolean;
  'demo_sweep.cron': string;
  // automatic e-mail receipt import (Path B): polls each user's configured IMAP
  // mailbox. The real gate is per-user (user_mailbox.enabled); this is the global
  // kill-switch + schedule. Inert when no mailbox is configured.
  'mailimport.enabled': boolean;
  'mailimport.cron': string;
  // drop-folder invoice import: scans a watched directory (e.g. invoices pulled
  // manually from a vendor portal) and treats each PDF/image like an e-mail
  // attachment (vision OCR → receipt). Deduped by file content hash.
  'dropfolder.enabled': boolean;
  'dropfolder.cron': string;
  'dropfolder.path': string;
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
  // monthly to-do push reminders (1st = budgets, 7th = uploads, 15th = finish receipts).
  // Push-only; per-user opt-out lives in notification_pref. One cron covers all three days.
  'reminders.enabled': boolean;
  'reminders.cron': string;
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
  'openai.url': 'https://api.openai.com',
  'openai.api_key': '',
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
  // Bank-matching agent: creative fallback after deterministic matching; reasoning
  // + restraint matter (must NOT force matches) → defaults to Claude.
  'ai.bankmatch.provider': 'anthropic',
  'ai.bankmatch.model': 'claude-sonnet-5',
  // Statistik NL assistant: only maps a question to filters (category/articles +
  // range + accounts) — a small, structured extraction → cheap DeepSeek is plenty.
  'ai.statsask.provider': 'deepseek',
  'ai.statsask.model': 'deepseek-v4-flash',
  // Bank-CSV column-mapping generator: reasons over a header + samples → a reusable mapping
  // spec. Needs solid reasoning → defaults to Claude (self-host without a key: switch to ollama).
  'ai.csvmapping.provider': 'anthropic',
  'ai.csvmapping.model': 'claude-sonnet-5',
  // Mail-reinterpret: user gives a free-text instruction on a skipped import and the model
  // reclassifies the mail as a corrected receipt or a one-off income. Reasoning over
  // untrusted mail text + a trusted instruction → defaults to Claude (self-host w/o key: ollama).
  'ai.mailreinterpret.provider': 'anthropic',
  'ai.mailreinterpret.model': 'claude-sonnet-5',
  'income.max_mail_amount': 100000,
  'churner.enabled': true,
  'churner.cron': '0 3 * * *',
  'churner.run_after_ocr': true,
  'churner.confidence': 0.85,
  'churner.batch_size': 200,
  'churner.hitl_mode': 'guarded',
  'searxng.url': '',
  'app.default_lang': 'de',
  'app.base_url': '',
  'webauthn.rp_id': '',
  'webauthn.origin': '',
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
  'demo_sweep.enabled': true,
  'demo_sweep.cron': '0 0 * * *', // demo only: wipe ephemeral demo households at midnight
  'mailimport.enabled': true,
  'mailimport.cron': '*/15 * * * *', // every 15 min — snappy "I forwarded it → it appears"
  'dropfolder.enabled': true,
  'dropfolder.cron': '*/15 * * * *', // every 15 min — "I dropped an invoice → it appears"
  'dropfolder.path': '/receipts/invoices', // subfolder of the mounted receipts store
  'push.vapid_public': '',
  'push.vapid_private': '',
  'push.vapid_subject': '',
  'offers.email_enabled': true,
  'offers.push_enabled': true,
  'shopping.email_enabled': true,
  'shopping.push_enabled': true,
  'reminders.enabled': true,
  'reminders.cron': '0 9 1,7,15 * *', // 09:00 Europe/Berlin on the 1st, 7th, 15th
  'categories.detail': 'mittel',
  'onboarding.done': false,
};

export async function getConfig<K extends keyof AppConfig>(key: K): Promise<AppConfig[K]> {
  const rows = await sql`SELECT value FROM app_config WHERE key = ${key}`;
  if (!rows.length) return DEFAULTS[key];
  return rows[0].value as AppConfig[K];
}

/**
 * The base URL to build links with. An explicitly configured `app.base_url` always wins (that is
 * the self-hoster behind their own proxy telling us the truth); when it is empty, the desktop build
 * fills in the address it is actually serving on — see desktopBaseUrl(). Docker keeps the old
 * behaviour exactly: unset stays unset.
 *
 * Use this instead of getConfig('app.base_url') anywhere a HUMAN will click the result.
 */
export async function effectiveBaseUrl(): Promise<string> {
  const stored = (await getConfig('app.base_url')).replace(/\/$/, '');
  return stored || desktopBaseUrl();
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

// ── Platform vs. household config (multi-tenant demo) ───────────────────────
// app_config has NO household_id column and no policy in migrations/demo/089_household_rls.sql,
// so RLS does not scope it: on the demo every row is platform-global and belongs to the operator.
// The read and write gates used to be two separate lists — a 5-key mask on GET and a ~14-prefix
// deny-pattern on PUT — and they drifted: 23 keys were write-protected but readable (ollama.url,
// searxng.url, smtp.host/port/user/from, dropfolder.path …), and more were neither, including
// `app.base_url`, the link host in every invite and reset mail the platform sends.
//
// A deny-pattern is the wrong polarity for a global table: every key nobody thought to name is
// exposed by default, which is exactly how `app.`, `household.`, `offers.` and `categories.`
// ended up open. Hence ONE allow-list governing BOTH directions — a new key now defaults to
// hidden instead of defaulting to leaked, and the two gates can no longer disagree.
//
// The list is EMPTY, and that is the point: because there is no household_id here, a
// household-scoped write to this table does not exist. A demo household admin who flips
// `offers.email_enabled` is not muting their own digest — they are muting the single global row
// that sendOfferDigests() reads for EVERY tenant (offers/index.ts), exactly as `shopping.*` is
// the global switch in routes/pantry.ts, `categories.detail` steers the category-designer prompt
// for every household (routes/categories.ts) and `offers.radius_km` sets the operator's nightly
// crawl radius (supermarket/info.ts). Same defect class as the cross-tenant INSERT on the
// household-less `unit` catalogue (routes/units.ts).
//
// What a demo household DOES own is persisted per household elsewhere and needs nothing from
// here: PUT /api/onboarding/profile writes address + categories_detail to their own `household`
// row (routes/demo.ts), the language pick is a FULL_STEPS-only wizard step, and the Admin page
// keeps the global switches behind `operatorOnly`. So: on the demo a household admin neither
// reads nor writes app_config, and every key is the operator's in both directions.
//
// Do NOT lengthen this list to make a section work — that trades a UI convenience for a
// cross-tenant write. The durable fix, if per-household settings are ever wanted here, is a
// household_id column + a tenant_isolation policy like every other tenant table has.
export const HOUSEHOLD_CONFIG_KEYS: readonly string[] = [];

/** May a demo household admin see/set this key? The single source of truth for both gates. */
export function isHouseholdConfigKey(key: string): boolean {
  return HOUSEHOLD_CONFIG_KEYS.includes(key);
}

/** The slice of the config a demo household admin may read — `{}` while the allow-list is empty.
 *  Operator keys are OMITTED, not masked: a '***' placeholder still confirms that a key exists
 *  and is set, and the old mask covered only 5 of them anyway. Callers must therefore treat every
 *  key as possibly absent (the Admin page hides the operator sections instead of rendering blanks). */
export function scopeConfigForHousehold(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of HOUSEHOLD_CONFIG_KEYS) if (k in cfg) out[k] = cfg[k];
  return out;
}
