// Marktguru offers API — a real, structured JSON source for German supermarket
// prospectus offers (no scraping). The API keys are embedded in the marktguru.de
// homepage inside <script type="application/json"> and rotate occasionally, so we
// fetch + cache them. Endpoint: GET /api/v1/offers/search?as=web&q=&zipCode=
// (Approach courtesy of the sydev/marktguru reverse-engineering work.)
const HOMEPAGE = 'https://www.marktguru.de/';
const API = 'https://api.marktguru.de/api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

let keyCache: { apiKey: string; clientKey: string; at: number } | null = null;
const KEY_TTL = 6 * 60 * 60 * 1000;

async function getKeys(): Promise<{ apiKey: string; clientKey: string }> {
  if (keyCache && Date.now() - keyCache.at < KEY_TTL) return keyCache;
  const res = await fetch(HOMEPAGE, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Marktguru homepage HTTP ${res.status}`);
  const html = await res.text();
  const re = /<script\s+type="application\/json">(.*?)<\/script>/gs;
  let m: RegExpExecArray | null;
  let apiKey = '', clientKey = '';
  while ((m = re.exec(html)) !== null) {
    try {
      const cfg = JSON.parse(m[1]) as { config?: { apiKey?: string; clientKey?: string }; apiKey?: string; clientKey?: string };
      const c = cfg?.config ?? cfg;
      if (c?.apiKey && c?.clientKey) { apiKey = c.apiKey; clientKey = c.clientKey; }
    } catch { /* not the config block */ }
  }
  if (!apiKey || !clientKey) throw new Error('Marktguru keys not found on homepage');
  keyCache = { apiKey, clientKey, at: Date.now() };
  return keyCache;
}

export interface MarktguruOffer {
  id: number;
  name: string;
  brand: string | null;
  retailers: string[];
  chainSlug: string | null; // marktguru advertiser uniqueName, e.g. "lidl"
  price: number | null;
  oldPrice: number | null;
  unit: string | null;
  validFrom: string | null; // ISO
  validTo: string | null;   // ISO
  url: string;
  image: string;
  categories: string[];
}

interface RawOffer {
  id: number; description?: string; price?: number; oldPrice?: number;
  brand?: { name?: string } | null;
  advertisers?: { name?: string; uniqueName?: string }[];
  unit?: { name?: string; shortName?: string } | null;
  validityDates?: { from?: string; to?: string }[];
  product?: { name?: string } | null;
  externalUrl?: string;
  categories?: { name?: string }[];
}

/** Search Marktguru for current offers near a zip code. Drops expired offers. */
export async function searchMarktguru(query: string, zipCode: string, limit = 20): Promise<MarktguruOffer[]> {
  const { apiKey, clientKey } = await getKeys();
  const params = new URLSearchParams({ as: 'web', q: query, zipCode: zipCode || '60487', limit: String(limit), offset: '0' });
  const res = await fetch(`${API}/offers/search?${params}`, {
    headers: { 'x-apikey': apiKey, 'x-clientkey': clientKey, 'User-Agent': UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Marktguru offers HTTP ${res.status}`);
  const data = (await res.json()) as { results?: RawOffer[] };
  const now = Date.now();
  return (data.results ?? []).map((r): MarktguruOffer => {
    const vd = (r.validityDates ?? [])[0] ?? {};
    const slug = (r.advertisers ?? [])[0]?.uniqueName ?? null;
    return {
      id: r.id,
      name: r.product?.name ?? r.description ?? '',
      brand: r.brand?.name ?? null,
      retailers: (r.advertisers ?? []).map(a => a.name ?? '').filter(Boolean),
      chainSlug: slug,
      price: typeof r.price === 'number' ? r.price : null,
      oldPrice: typeof r.oldPrice === 'number' ? r.oldPrice : null,
      unit: r.unit?.shortName ?? r.unit?.name ?? null,
      validFrom: vd.from ?? null,
      validTo: vd.to ?? null,
      // Link the human-viewable retailer prospectus (flipbook) when we know the
      // chain; else fall back to the offer's prospectus image.
      url: slug
        ? `https://www.marktguru.de/rp/${slug}-prospekte`
        : (r.externalUrl || `https://mg2de.b-cdn.net/api/v1/offers/${r.id}/images/default/0/large.jpg`),
      image: `https://mg2de.b-cdn.net/api/v1/offers/${r.id}/images/default/0/medium.jpg`,
      categories: (r.categories ?? []).map(c => c.name ?? '').filter(Boolean),
    };
  }).filter(o => !o.validTo || Date.parse(o.validTo) >= now);
}

/** Health check: can we obtain the API keys? */
export async function marktguruHealth(): Promise<{ ok: boolean; error?: string }> {
  try { await getKeys(); return { ok: true }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
