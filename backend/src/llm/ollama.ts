import { getConfig } from '../config.js';

export interface OllamaChatOptions {
  system: string;
  user: string;
  json?: boolean;
  model?: string;
}

export async function ollamaChat(opts: OllamaChatOptions): Promise<string> {
  const url = await getConfig('ollama.url');
  const model = opts.model ?? (await getConfig('ollama.model'));
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
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
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? '';
}

/** Robust JSON extraction: Ollama sometimes wraps JSON in prose or code fences. */
export function parseLlmJson<T>(raw: string): T {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.search(/[[{]/);
    if (start === -1) throw new Error(`LLM returned no JSON: ${raw.slice(0, 200)}`);
    const open = trimmed[start];
    const close = open === '[' ? ']' : '}';
    const end = trimmed.lastIndexOf(close);
    if (end <= start) throw new Error(`LLM returned malformed JSON: ${raw.slice(0, 200)}`);
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }
}

export async function listOllamaModels(): Promise<string[]> {
  const url = await getConfig('ollama.url');
  const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map(m => m.name);
}

export async function ollamaHealth(): Promise<{ ok: boolean; version?: string; error?: string }> {
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
