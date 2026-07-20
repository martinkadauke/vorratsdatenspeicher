import { jsonrepair } from 'jsonrepair';

/** Robust JSON extraction from an LLM response. LLMs wrap JSON in prose / ```json
 *  fences AND regularly emit slightly-invalid JSON — most often an UNESCAPED quote
 *  inside a string (e.g. a German „…" where the closing quote is a straight ") or a
 *  trailing comma. We try, in order: the trimmed text, the first {...}/[...] slice,
 *  then a jsonrepair() pass on each — so a stray quote no longer 502s the request. */
export function parseLlmJson<T>(raw: string): T {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const candidates: string[] = [trimmed];
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const end = trimmed.lastIndexOf(trimmed[start] === '[' ? ']' : '}');
    if (end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  for (const c of candidates) { try { return JSON.parse(c) as T; } catch { /* try next */ } }
  for (const c of candidates) { try { return JSON.parse(jsonrepair(c)) as T; } catch { /* try next */ } }
  throw new Error(`LLM returned unparseable JSON: ${raw.slice(0, 200)}`);
}

// Re-exports for backwards compatibility.
// New code should `import from '../llm/provider.js'` directly.
export { listOllamaModels, ollamaHealth } from './provider.js';
