// Store discovery via OpenStreetMap (free, no API key, deterministic — no AI/hallucination).
// Geocodes the household address (once, cached on the household), then queries Overpass for
// real shops nearby and inserts them as store_branch rows for the active household. Used to
// seed a brand-new household's Läden list (offers/by-store need stores) and to add a single
// named store on demand.
import sql, { DEMO_MODE } from '../db.js';
import { householdGeo, setHouseholdCoords } from '../lib/household.js';
import { haversineKm } from '../lib/geo.js';

const UA = 'Vorratsdatenspeicher/1.0 (self-hosted household app)';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function geocode(address: string): Promise<{ lat: number; lon: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const data = (await res.json()) as { lat: string; lon: string }[];
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

interface OsmShop { name: string; lat: number; lon: number; address: string | null; distKm: number }

/** Overpass shops around a point. Either a shop-TYPE regex (discovery) or a NAME filter
 *  (add-by-name, any shop tag). Returns de-duped by name, sorted nearest-first. */
async function overpassShops(
  lat: number, lon: number, radiusM: number,
  opts: { typeRe?: string; nameFilter?: string; limit?: number },
): Promise<OsmShop[]> {
  const clean = (s: string) => s.replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const shopSel = opts.nameFilter
    ? `["shop"]["name"~"${clean(opts.nameFilter)}",i]`
    : `["shop"~"${opts.typeRe ?? 'supermarket|convenience|chemist|greengrocer|butcher|bakery|beverages'}"]`;
  const q = `[out:json][timeout:25];(`
    + `node${shopSel}(around:${radiusM},${lat},${lon});`
    + `way${shopSel}(around:${radiusM},${lat},${lon});`
    + `);out center ${opts.limit ?? 50};`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'data=' + encodeURIComponent(q),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    elements?: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[];
  };
  const seen = new Set<string>();
  const out: OsmShop[] = [];
  for (const el of data.elements ?? []) {
    const name = el.tags?.name?.trim();
    if (!name) continue;
    const elLat = el.lat ?? el.center?.lat;
    const elLon = el.lon ?? el.center?.lon;
    if (elLat == null || elLon == null) continue;
    const k = name.toLowerCase();
    if (seen.has(k)) continue; // one entry per distinct store name
    seen.add(k);
    const street = [el.tags?.['addr:street'], el.tags?.['addr:housenumber']].filter(Boolean).join(' ');
    const city = [el.tags?.['addr:postcode'], el.tags?.['addr:city']].filter(Boolean).join(' ');
    const address = [street, city].filter(Boolean).join(', ') || null;
    out.push({ name, lat: elLat, lon: elLon, address, distKm: haversineKm(lat, lon, elLat, elLon) });
  }
  return out.sort((a, b) => a.distKm - b.distKm);
}

/** Insert one shop as a store_branch for the ACTIVE household, if not already present.
 *  Returns 1 if inserted. Pre-checks (RLS-scoped on demo) to avoid the demo vs self-host
 *  unique-index / household_id-default differences. */
async function insertBranch(s: OsmShop): Promise<number> {
  const existing = await sql`SELECT 1 FROM store_branch WHERE kind = 'filiale' AND name = ${s.name} LIMIT 1`;
  if (existing.length) return 0;
  if (DEMO_MODE) {
    // household_id default is a plain 1 → the RLS WITH CHECK rejects it for other households; set it.
    await sql`
      INSERT INTO store_branch (household_id, chain_key, name, kind, address, lat, lon)
      VALUES (NULLIF(current_setting('app.current_household', true), '')::bigint,
              normalize_store(${s.name}), ${s.name}, 'filiale', ${s.address}, ${s.lat}, ${s.lon})`;
  } else {
    await sql`
      INSERT INTO store_branch (chain_key, name, kind, address, lat, lon)
      VALUES (normalize_store(${s.name}), ${s.name}, 'filiale', ${s.address}, ${s.lat}, ${s.lon})`;
  }
  return 1;
}

/** Ensure the active household has cached coords (geocode from its address once). */
async function ensureCoords(): Promise<{ lat: number; lon: number } | null> {
  const geo = await householdGeo();
  if (!geo.address) return null;
  if (geo.lat != null && geo.lon != null) return { lat: geo.lat, lon: geo.lon };
  const loc = await geocode(geo.address);
  await sleep(1100); // Nominatim ≤1 req/s
  if (!loc) return null;
  await setHouseholdCoords(loc.lat, loc.lon);
  return loc;
}

export type DiscoverReason = 'ok' | 'no_address' | 'geocode_failed' | 'not_found' | 'exists';

/** Discover supermarkets/drugstores near the household address and add them. Best-effort. */
export async function discoverStoresForHousehold(radiusKm = 6): Promise<{ added: number; found: number; reason: DiscoverReason }> {
  const coords = await ensureCoords();
  if (!coords) {
    const geo = await householdGeo();
    return { added: 0, found: 0, reason: geo.address ? 'geocode_failed' : 'no_address' };
  }
  const shops = await overpassShops(coords.lat, coords.lon, Math.round(radiusKm * 1000), { limit: 60 });
  let added = 0;
  for (const s of shops) added += await insertBranch(s);
  return { added, found: shops.length, reason: 'ok' };
}

/** Add a single named store near the household address (OSM). */
export async function addStoreByName(rawName: string): Promise<{ added: boolean; name?: string; reason: DiscoverReason }> {
  const name = rawName.trim();
  if (!name) return { added: false, reason: 'not_found' };
  const coords = await ensureCoords();
  if (!coords) {
    const geo = await householdGeo();
    return { added: false, reason: geo.address ? 'geocode_failed' : 'no_address' };
  }
  // A specific chain may sit a few towns over → search a wide radius by name.
  const hits = await overpassShops(coords.lat, coords.lon, 30_000, { nameFilter: name, limit: 12 });
  if (!hits.length) return { added: false, reason: 'not_found' };
  const nearest = hits[0];
  const inserted = await insertBranch(nearest);
  return inserted ? { added: true, name: nearest.name, reason: 'ok' } : { added: false, name: nearest.name, reason: 'exists' };
}
