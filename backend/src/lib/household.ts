import sql, { DEMO_MODE } from '../db.js';
import { getConfig, setConfig } from '../config.js';

export interface HouseholdGeo { address: string; lat: number | null; lon: number | null }

/**
 * The ACTIVE household's address + cached coordinates, read from the right place per mode:
 *  - demo → the household row itself (RLS-scoped to the request's household), so a signed-up
 *    household uses ITS OWN onboarding address — not the platform operator's global config.
 *  - self-host → app_config (`household.address` / `.lat` / `.lon`), the single household.
 * On demo this MUST be called inside the request's tenant context (offer refresh, store
 * discovery) so `app.current_household` is set.
 */
export async function householdGeo(): Promise<HouseholdGeo> {
  if (DEMO_MODE) {
    const [h] = await sql`
      SELECT address, lat, lon FROM household
      WHERE id = NULLIF(current_setting('app.current_household', true), '')::bigint`;
    return {
      address: String((h?.address as string | null) ?? '').trim(),
      lat: h?.lat != null ? Number(h.lat) : null,
      lon: h?.lon != null ? Number(h.lon) : null,
    };
  }
  const address = String((await getConfig('household.address')) ?? '').trim();
  const lat = await getConfig('household.lat');
  const lon = await getConfig('household.lon');
  return { address, lat: lat ? Number(lat) : null, lon: lon ? Number(lon) : null };
}

/** Persist geocoded coords for the active household (demo → its row; self-host → config). */
export async function setHouseholdCoords(lat: number, lon: number): Promise<void> {
  if (DEMO_MODE) {
    await sql`UPDATE household SET lat = ${lat}, lon = ${lon}
      WHERE id = NULLIF(current_setting('app.current_household', true), '')::bigint`;
  } else {
    await setConfig('household.lat', lat);
    await setConfig('household.lon', lon);
  }
}

/** 5-digit German ZIP from an address string (Marktguru needs it). '' if none. */
export function zipFromAddress(addr: string): string {
  return addr.match(/\b(\d{5})\b/)?.[1] ?? '';
}

/** City / region hint from an address, to bias search locally. '' if none. */
export function regionFromAddress(addr: string): string {
  const a = addr.trim();
  if (!a) return '';
  const m = a.match(/\d{5}\s+([^\d,]+)/);
  if (m) return m[1].trim();
  return a.split(',').pop()!.trim();
}
