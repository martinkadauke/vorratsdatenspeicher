/** Robust JSON extraction: LLMs sometimes wrap JSON in prose or ```json fences. */
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

// Re-exports for backwards compatibility.
// New code should `import from '../llm/provider.js'` directly.
export { listOllamaModels, ollamaHealth } from './provider.js';
