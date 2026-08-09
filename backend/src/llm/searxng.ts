import { getConfig } from '../config.js';

/** Is a web search available at all?
 *
 *  ⚠️ An unset URL must be a QUIET no, not an exception. Web search is an enhancement here — the
 *  churner's stage 1 already proposes a name and the icons are decoration — but throwing made it
 *  behave like a dependency: the per-article guard caught the error and abandoned that article
 *  entirely, so on any instance without SearXNG the very items that needed help were the ones that
 *  never got a canonical name at all, run after run, one logged error each. Desktop installs have
 *  no SearXNG at all, which is exactly the case this punished hardest. */
async function searchBase(): Promise<string | null> {
  // ⚠️ The desktop build ships its OWN SearXNG and hands us its address in the environment. That
  // is a fact of the running install, not a preference: the port is chosen fresh at every boot, so
  // a value stored in app_config would be stale after the first restart — the same reasoning that
  // makes effectiveBaseUrl() prefer the live tunnel address over a configured one. Docker never
  // sets it, so self-hosters keep pointing us at their own instance exactly as before.
  const fact = process.env.SEARXNG_URL?.trim();
  const base = (fact || (await getConfig('searxng.url')))?.trim();
  return base ? base.replace(/\/$/, '') : null;
}

export interface SearchHit {
  title: string;
  content: string;
  url: string;
}

export async function searxngSearch(query: string): Promise<SearchHit[]> {
  const base = await searchBase();
  if (!base) return [];
  const params = new URLSearchParams({
    q: `${query} produkt deutschland`,
    format: 'json',
    categories: 'general,shopping',
    language: 'de',
  });
  const res = await fetch(`${base}/search?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; content?: string; url?: string }[] };
  return (data.results ?? []).slice(0, 5).map(r => ({
    title: r.title ?? '',
    content: r.content ?? '',
    url: r.url ?? '',
  }));
}

/** Raw web search with the query passed through verbatim (no extra keywords). */
export async function searxngSearchRaw(query: string): Promise<SearchHit[]> {
  const base = await searchBase();
  if (!base) return [];
  const params = new URLSearchParams({ q: query, format: 'json', language: 'de' });
  const res = await fetch(`${base}/search?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; content?: string; url?: string }[] };
  return (data.results ?? []).slice(0, 6).map(r => ({
    title: r.title ?? '', content: r.content ?? '', url: r.url ?? '',
  }));
}

export async function searxngImageSearch(query: string): Promise<{ src: string; thumb: string; title: string }[]> {
  const base = await searchBase();
  if (!base) return [];
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    categories: 'images',
    language: 'de',
    safesearch: '1',
  });
  const res = await fetch(`${base}/search?${params}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { img_src?: string; thumbnail_src?: string; title?: string }[] };
  return (data.results ?? []).slice(0, 5).map(r => ({
    src: r.img_src ?? r.thumbnail_src ?? '',
    thumb: r.thumbnail_src ?? r.img_src ?? '',
    title: r.title ?? '',
  })).filter(r => r.src);
}

export async function searxngHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    // Through the same resolver as every real query, or the health check would report on a
    // different instance than the one the app actually uses.
    const base = await searchBase();
    if (!base) return { ok: false, error: 'nicht konfiguriert' };
    const res = await fetch(`${base}/search?q=test&format=json`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} — ist format=json in settings.yml erlaubt?` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
