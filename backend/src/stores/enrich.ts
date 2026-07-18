// Store/shop contact enrichment runner: fills store_branch.address / website / phone
// automatically instead of manual entry. Physical branches (kind='filiale') → OSM Overpass
// (address + website + phone tags near the household), with a SearXNG+LLM web-search fallback
// for a missing website; online shops (kind='shop') → web-search for the website only.
// Runs over ALL of the active household's stores. Never overwrites a value that's already set.
import sql from '../db.js';
import { householdGeo, setHouseholdCoords } from '../lib/household.js';
import { haversineKm } from '../lib/geo.js';
import { searxngSearchRaw } from '../llm/searxng.js';
import { providerForTask } from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';

const UA = 'Vorratsdatenspeicher/1.0 (self-hosted household app)';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function geocode(address: string): Promise<{ lat: number; lon: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { lat: string; lon: string }[];
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function ensureCoords(): Promise<{ lat: number; lon: number } | null> {
  const geo = await householdGeo();
  if (!geo.address) return null;
  if (geo.lat != null && geo.lon != null) return { lat: geo.lat, lon: geo.lon };
  const loc = await geocode(geo.address);
  await sleep(1100);
  if (!loc) return null;
  await setHouseholdCoords(loc.lat, loc.lon);
  return loc;
}

interface OsmContact { address: string | null; website: string | null; phone: string | null; opening_hours: string | null }

/** OSM tags (address / website / phone) of the nearest shop matching `name` near (lat,lon). */
async function overpassContact(name: string, lat: number, lon: number, radiusM: number): Promise<OsmContact | null> {
  const clean = name.replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (!clean) return null;
  const q = `[out:json][timeout:25];(`
    + `node["shop"]["name"~"${clean}",i](around:${radiusM},${lat},${lon});`
    + `way["shop"]["name"~"${clean}",i](around:${radiusM},${lat},${lon});`
    + `);out center 12;`;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) continue;
      const data = (await res.json()) as {
        elements?: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[];
      };
      let best: Record<string, string> | null = null;
      let bestKm = Infinity;
      for (const el of data.elements ?? []) {
        const elLat = el.lat ?? el.center?.lat;
        const elLon = el.lon ?? el.center?.lon;
        if (elLat == null || elLon == null) continue;
        const d = haversineKm(lat, lon, elLat, elLon);
        if (d < bestKm) { bestKm = d; best = el.tags ?? {}; }
      }
      if (!best) return null;
      const street = [best['addr:street'], best['addr:housenumber']].filter(Boolean).join(' ');
      const city = [best['addr:postcode'], best['addr:city']].filter(Boolean).join(' ');
      return {
        address: [street, city].filter(Boolean).join(', ') || null,
        website: best['website'] ?? best['contact:website'] ?? null,
        phone: best['phone'] ?? best['contact:phone'] ?? null,
        opening_hours: best['opening_hours'] ?? null,
      };
    } catch { /* try next mirror */ }
  }
  return null;
}

const SITE_PROMPT = 'Du erhältst Web-Suchergebnisse zu einem Laden oder Online-Shop. Gib die offizielle Haupt-Website (Startseite) zurück — kein Marktplatz-, Bewertungs- oder Wikipedia-Link. Antworte NUR als JSON: {"website": "https://…" oder null}.';

/** SearXNG + LLM: the official website URL for a store/shop by name (null if unsure). */
async function websearchWebsite(name: string): Promise<string | null> {
  let hits: { title: string; content: string; url: string }[];
  try { hits = await searxngSearchRaw(`${name} offizielle Website`); } catch { return null; }
  if (!hits.length) return null;
  try {
    const llm = await providerForTask('churner_stage2');
    const ex = parseLlmJson<{ website?: string | null }>(await llm.chat({ system: SITE_PROMPT, user: JSON.stringify(hits.slice(0, 5)), json: true }));
    const w = (ex.website ?? '').trim();
    return /^https?:\/\/\S+$/.test(w) ? w : null;
  } catch { return null; }
}

export type EnrichReason = 'ok' | 'no_address';

/** Enrich every store/shop of the active household with address/website/phone. Best-effort;
 *  never overwrites an already-set value. */
export async function enrichStores(): Promise<{ enriched: number; total: number; reason: EnrichReason }> {
  const coords = await ensureCoords(); // needed for the physical-branch OSM lookup
  const branches = await sql`SELECT id, name, kind, address, website, phone, opening_hours FROM store_branch`;
  let enriched = 0;
  for (const b of branches) {
    const name = b.name as string;
    const updates: Record<string, unknown> = {};
    if (b.kind === 'filiale') {
      if (coords) {
        const c = await overpassContact(name, coords.lat, coords.lon, 30_000);
        if (c) {
          if (!b.address && c.address) updates.address = c.address;
          if (!b.website && c.website) updates.website = c.website;
          if (!b.phone && c.phone) updates.phone = c.phone;
          // Opening hours: fill the field from OSM's opening_hours tag. Refresh an
          // earlier OSM value, but never clobber a hand-typed one (same rule the
          // supermarket/info crawler uses: protect anything whose source ≠ 'osm').
          const ohSource = (b.opening_hours as { source?: string } | null)?.source;
          const ohProtected = b.opening_hours != null && ohSource !== 'osm';
          if (!ohProtected && c.opening_hours) {
            updates.opening_hours = JSON.stringify({ text: c.opening_hours, source: 'osm', updated_at: new Date().toISOString() });
          }
        }
        await sleep(1200); // gentle on the public Overpass instances
      }
      // Web-search fallback for a website OSM didn't have.
      if (!b.website && !updates.website) { const w = await websearchWebsite(name); if (w) updates.website = w; }
    } else {
      // Online shop → website via web-search only.
      if (!b.website) { const w = await websearchWebsite(name); if (w) updates.website = w; }
    }
    if (Object.keys(updates).length) {
      updates.updated_at = new Date();
      await sql`UPDATE store_branch SET ${sql(updates)} WHERE id = ${b.id}`;
      enriched++;
    }
  }
  return { enriched, total: branches.length, reason: coords ? 'ok' : 'no_address' };
}
