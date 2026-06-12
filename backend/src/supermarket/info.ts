// Supermarket info crawler: fills store_branch.opening_hours from OpenStreetMap
// (free, no API key). Geocodes the household address once via Nominatim, then
// for each branch looks up the nearest matching shop via Overpass and copies
// its opening_hours tag. Manual entries are never overwritten.
//
// This is the first of several "Supermarkt Infos" the cron will gather; later
// it can also pull leaflets / offers.
import sql from '../db.js';
import { getConfig } from '../config.js';
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

/** Nearest shop matching `chain` within radius → its opening_hours tag (or null). */
async function overpassHours(chain: string, lat: number, lon: number, radiusM: number): Promise<string | null> {
  const name = chain.replace(/[^\p{L}\p{N} ]/gu, '').trim(); // strip regex-special chars
  if (!name) return null;
  const q = `[out:json][timeout:25];(`
    + `node["shop"]["name"~"${name}",i](around:${radiusM},${lat},${lon});`
    + `way["shop"]["name"~"${name}",i](around:${radiusM},${lat},${lon});`
    + `);out tags 8;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'data=' + encodeURIComponent(q),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { elements?: { tags?: Record<string, string> }[] };
  for (const el of data.elements ?? []) {
    if (el.tags?.opening_hours) return el.tags.opening_hours;
  }
  return null;
}

/** Run the crawler. Records a maintenance_event and returns its id. */
export async function runSupermarketInfo(): Promise<number> {
  if (running) throw new Error('Supermarkt-Infos laufen bereits');
  running = true;
  const [ev] = await sql`INSERT INTO maintenance_event (kind, status) VALUES ('supermarket.info', 'running') RETURNING id`;
  const eventId = ev.id as number;
  let checked = 0, updated = 0;
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
    const radiusM = Math.round(radiusKm * 1000);
    const branches = await sql`SELECT id, name FROM store_branch WHERE kind = 'filiale'`;
    for (const b of branches) {
      checked++;
      try {
        const chain = (b.name as string).split(/\s+/)[0]; // "LIDL Tübingen" → "LIDL"
        const oh = await overpassHours(chain, loc.lat, loc.lon, radiusM);
        if (oh) {
          // never clobber a manually-entered value (those have no source field)
          const r = await sql`
            UPDATE store_branch
            SET opening_hours = ${sql.json({ text: oh, source: 'osm', updated_at: new Date().toISOString() })},
                updated_at = NOW()
            WHERE id = ${b.id}
              AND (opening_hours IS NULL OR opening_hours->>'source' = 'osm')
          `;
          if (r.count) updated++;
        }
      } catch { /* skip this branch, keep going */ }
      await sleep(1500); // be gentle to the public Overpass instance
    }

    // Then refresh offers for subscribed products and email the digests.
    let offers = { checked: 0, found: 0 };
    try { offers = await runOfferSearch(); await sendOfferDigests(); }
    catch (e) { console.error('[supermarket] offer search failed:', (e as Error).message); }

    await sql`UPDATE maintenance_event SET status='done', ended_at=NOW(),
      summary=${sql.json({ checked, updated, offers_checked: offers.checked, offers_found: offers.found })} WHERE id=${eventId}`;
    return eventId;
  } catch (e) {
    await sql`UPDATE maintenance_event SET status='error', ended_at=NOW(),
      summary=${sql.json({ error: (e as Error).message, checked, updated })} WHERE id=${eventId}`;
    return eventId;
  } finally {
    running = false;
  }
}
