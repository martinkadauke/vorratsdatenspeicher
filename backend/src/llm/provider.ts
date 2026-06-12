import sql from '../db.js';
import { getConfig, setConfig } from '../config.js';

export type ProviderName = 'ollama' | 'deepseek' | 'anthropic';
export type AiTask = 'recategorize' | 'churner_stage1' | 'churner_stage2' | 'ocr' | 'categories_chat';

export interface LlmChatOptions {
  system: string;
  user: string;
  json?: boolean;
}

export interface LlmProvider {
  name: ProviderName;
  chat(opts: LlmChatOptions): Promise<string>;
}

export interface HealthInfo {
  ok: boolean;
  version?: string;
  error?: string;
}

// ── Ollama ──────────────────────────────────────────────────────────────
class OllamaProvider implements LlmProvider {
  readonly name: ProviderName = 'ollama';
  constructor(private url: string, private model: string) {}

  async chat(opts: LlmChatOptions): Promise<string> {
    const res = await fetch(`${this.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: opts.json ? 'json' : undefined,
        options: { temperature: 0.1 },
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await safeBody(res)}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }
}

export async function listOllamaModels(): Promise<string[]> {
  const url = await getConfig('ollama.url');
  const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map(m => m.name);
}

export async function ollamaHealth(): Promise<HealthInfo> {
  try {
    const url = await getConfig('ollama.url');
    const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { version?: string };
    return { ok: true, version: data.version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── DeepSeek (OpenAI-compatible API) ────────────────────────────────────
class DeepSeekProvider implements LlmProvider {
  readonly name: ProviderName = 'deepseek';
  constructor(private url: string, private apiKey: string, private model: string) {
    if (!apiKey) throw new Error('DeepSeek API-Key fehlt — in Admin → AI Settings setzen');
  }

  async chat(opts: LlmChatOptions): Promise<string> {
    const res = await fetch(`${this.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        response_format: opts.json ? { type: 'json_object' } : undefined,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${await safeBody(res)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }
}

export async function listDeepSeekModels(): Promise<string[]> {
  const url = await getConfig('deepseek.url');
  const apiKey = await getConfig('deepseek.api_key');
  if (!apiKey) throw new Error('DeepSeek API-Key fehlt');
  const res = await fetch(`${url}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${await safeBody(res)}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map(m => m.id);
}

export async function deepseekHealth(): Promise<HealthInfo> {
  try {
    const apiKey = await getConfig('deepseek.api_key');
    if (!apiKey) return { ok: false, error: 'API-Key fehlt' };
    await listDeepSeekModels();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Anthropic (Claude Messages API) ─────────────────────────────────────
class AnthropicProvider implements LlmProvider {
  readonly name: ProviderName = 'anthropic';
  constructor(private apiKey: string, private model: string) {
    if (!apiKey) throw new Error('Anthropic API-Key fehlt — in Admin → AI Settings setzen');
  }

  async chat(opts: LlmChatOptions): Promise<string> {
    // Claude doesn't have an OpenAI-style "json_object" flag — we just
    // make the system prompt strict, and parseLlmJson() is tolerant.
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await safeBody(res)}`);
    const data = (await res.json()) as { content?: { text?: string }[] };
    return data.content?.[0]?.text ?? '';
  }
}

export async function listAnthropicModels(): Promise<string[]> {
  const url = await getConfig('anthropic.url');
  const apiKey = await getConfig('anthropic.api_key');
  if (!apiKey) throw new Error('Anthropic API-Key fehlt');
  const res = await fetch(`${url}/v1/models`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await safeBody(res)}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map(m => m.id);
}

export async function anthropicHealth(): Promise<HealthInfo> {
  try {
    const apiKey = await getConfig('anthropic.api_key');
    if (!apiKey) return { ok: false, error: 'API-Key fehlt' };
    await listAnthropicModels();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Per-task resolver ───────────────────────────────────────────────────
/** Resolve which provider/model to use for a given AI task. */
export async function providerForTask(task: AiTask): Promise<LlmProvider> {
  const provider = (await getConfig(`ai.${task}.provider` as `ai.recategorize.provider`)) as ProviderName;
  const model = await getConfig(`ai.${task}.model` as `ai.recategorize.model`);

  if (provider === 'deepseek') {
    const url = await getConfig('deepseek.url');
    const apiKey = await getConfig('deepseek.api_key');
    return new DeepSeekProvider(url, apiKey, model);
  }
  if (provider === 'anthropic') {
    const apiKey = await getConfig('anthropic.api_key');
    return new AnthropicProvider(apiKey, model);
  }
  // default: ollama
  const url = await getConfig('ollama.url');
  return new OllamaProvider(url, model);
}

/** List models for a provider. */
export async function listModelsForProvider(provider: ProviderName): Promise<string[]> {
  if (provider === 'deepseek') return listDeepSeekModels();
  if (provider === 'anthropic') return listAnthropicModels();
  return listOllamaModels();
}

/** Health check for a provider. */
export async function healthForProvider(provider: ProviderName): Promise<HealthInfo> {
  if (provider === 'deepseek') return deepseekHealth();
  if (provider === 'anthropic') return anthropicHealth();
  return ollamaHealth();
}

/** Set provider+model for a task atomically. Logs the change so the admin
 *  can later see which model was active for which task at any point. */
export async function setTaskAi(
  task: AiTask,
  provider: ProviderName,
  model: string,
  userId?: number,
  source: 'manual' | 'auto_review' = 'manual',
): Promise<void> {
  await setConfig(`ai.${task}.provider`, provider, userId);
  await setConfig(`ai.${task}.model`, model, userId);
  await sql`
    INSERT INTO ai_task_log (task, provider, model, source, changed_by)
    VALUES (${task}, ${provider}, ${model}, ${source}, ${userId ?? null})
  `;
}

async function safeBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}
