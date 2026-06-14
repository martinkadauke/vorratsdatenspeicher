// Supermarket info crawler: fills store_branch.opening_hours from OpenStreetMap
// (free, no API key). Geocodes the household address once via Nominatim, then
// for each branch looks up the nearest matching shop via Overpass and copies
// its opening_hours tag. Manual entries are never overwritten.
//
// This is the first of several "Supermarkt Infos" the cron will gather; later
// it can also pull leaflets / offers.
import sql from '../db.js';
import { getConfig, setConfig } from '../config.js';
import { haversineKm } from '../lib/geo.js';
import { runOfferSearch, sendOfferDigests } from '../offers/index.js';

let running = false;
export function isSupermarketRunning(): boolean { return running; }

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

/** Nearest shop matching `chain` within radius → its opening_hours + coordinates
 *  (the branch location, for distance-from-household). null if nothing matched.
 *  `out center` gives node lat/lon and a center for ways. */
async function overpassNearest(chain: string, lat: number, lon: number, radiusM: number):
  Promise<{ hours: string | null; lat: number | null; lon: number | null } | null> {
  const name = chain.replace(/[^\p{L}\p{N} ]/gu, '').trim(); // strip regex-special chars
  if (!name) return null;
  const q = `[out:json][timeout:25];(`
    + `node["shop"]["name"~"${name}",i](around:${radiusM},${lat},${lon});`
    + `way["shop"]["name"~"${name}",i](around:${radiusM},${lat},${lon});`
    + `);out center 8;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'data=' + encodeURIComponent(q),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    elements?: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[];
  };
  const els = data.elements ?? [];
  if (!els.length) return null;
  // Pick the element geographically nearest the household = the relevant branch.
  let nearest: { lat: number; lon: number; hours: string | null } | null = null;
  let nearestKm = Infinity;
  for (const el of els) {
    const elLat = el.lat ?? el.center?.lat;
    const elLon = el.lon ?? el.center?.lon;
    if (elLat == null || elLon == null) continue;
    const d = haversineKm(lat, lon, elLat, elLon);
    if (d < nearestKm) { nearestKm = d; nearest = { lat: elLat, lon: elLon, hours: el.tags?.opening_hours ?? null }; }
  }
  const anyHours = els.find(e => e.tags?.opening_hours)?.tags?.opening_hours ?? null;
  if (nearest) return { hours: nearest.hours ?? anyHours, lat: nearest.lat, lon: nearest.lon };
  return anyHours ? { hours: anyHours, lat: null, lon: null } : null;
}

/** Run the crawler. Records a maintenance_event and returns its id. */
export async function runSupermarketInfo(): Promise<number> {
  if (running) throw new Error('Supermarkt-Infos laufen bereits');
  running = true;
  const [ev] = await sql`INSERT INTO maintenance_event (kind, status) VALUES ('supermarket.info', 'running') RETURNING id`;
  const eventId = ev.id as number;
  let checked = 0, updated = 0, geocoded = 0;
  try {
    const address = await getConfig('household.address');
    const radiusKm = (await getConfig('offers.radius_km')) || 10;
    if (!address) {
      await sql`UPDATE maintenance_event SET status='done', ended_at=NOW(),
        summary=${sql.json({ note: 'no household address set', checked: 0, updated: 0 })} WHERE id=${eventId}`;
      return eventId;
    }
    const loc = await geocode(address);
    await sleep(1100); // Nominatim: ≤1 req/s
    if (!loc) {
      await sql`UPDATE maintenance_event SET status='done', ended_at=NOW(),
        summary=${sql.json({ note: 'geocode failed', checked: 0, updated: 0 })} WHERE id=${eventId}`;
      return eventId;
    }
    // Cache the household coordinates so the recommendation/distance code never
    // has to re-geocode.
    await setConfig('household.lat', loc.lat);
    await setConfig('household.lon', loc.lon);
    const radiusM = Math.round(radiusKm * 1000);
    const branches = await sql`SELECT id, name FROM store_branch WHERE kind = 'filiale'`;
    for (const b of branches) {
      checked++;
      try {
        const chain = (b.name as string).split(/\s+/)[0]; // "LIDL Tübingen" → "LIDL"
        const m = await overpassNearest(chain, loc.lat, loc.lon, radiusM);
        if (m?.hours) {
          // never clobber a manually-entered value (those have no source field)
          const r = await sql`
            UPDATE store_branch
            SET opening_hours = ${sql.json({ text: m.hours, source: 'osm', updated_at: new Date().toISOString() })},
                updated_at = NOW()
            WHERE id = ${b.id}
              AND (opening_hours IS NULL OR opening_hours->>'source' = 'osm')
          `;
          if (r.count) updated++;
        }
        // Persist the branch location (for distance-from-household). No manual
        // coord editing exists yet, so OSM is authoritative — refresh each run.
        if (m && m.lat != null && m.lon != null) {
          await sql`UPDATE store_branch SET lat = ${m.lat}, lon = ${m.lon}, updated_at = NOW() WHERE id = ${b.id}`;
          geocoded++;
        }
      } catch { /* skip this branch, keep going */ }
      await sleep(1500); // be gentle to the public Overpass instance
    }

    // Then refresh offers for subscribed products and email the digests.
    let offers = { checked: 0, found: 0 };
    try { offers = await runOfferSearch(); await sendOfferDigests(); }
    catch (e) { console.error('[supermarket] offer search failed:', (e as Error).message); }

    await sql`UPDATE maintenance_event SET status='done', ended_at=NOW(),
      summary=${sql.json({ checked, updated, geocoded, offers_checked: offers.checked, offers_found: offers.found })} WHERE id=${eventId}`;
    return eventId;
  } catch (e) {
    await sql`UPDATE maintenance_event SET status='error', ended_at=NOW(),
      summary=${sql.json({ error: (e as Error).message, checked, updated })} WHERE id=${eventId}`;
    return eventId;
  } finally {
    running = false;
  }
}
