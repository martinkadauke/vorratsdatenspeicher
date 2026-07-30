import type { FastifyInstance } from 'fastify';
import sql, { DEMO_MODE } from '../db.js';
import { getConfig } from '../config.js';

interface SearxImage { thumbnail_src?: string; img_src?: string; url?: string; title?: string; source?: string }

/** Demo-only brake on the icon search below, which proxies into the operator's PRIVATE SearXNG.
 *
 *  Deliberately NOT requireOperator, unlike /api/offers/debug and /api/searxng/health: those are
 *  operator diagnostics with no UI caller, while this one IS the household feature — the icon
 *  picker in Artikel / Namen / Läden (components/IconPicker.tsx) — so a guard there would only
 *  break the demo. What must not be free is LOOPING it: every hit spends the operator's IP with
 *  the upstream engines SearXNG queries, and getting that IP throttled takes the offer web-search
 *  down with it.
 *
 *  In memory rather than a household counter column: this costs no AI tokens, so it does not
 *  belong in the shared ai_count bucket (a visitor picking icons must not exhaust the budget the
 *  assistant needs), and a dedicated column would need a migration for something a process-local
 *  window bounds just as well. Losing the window on restart is acceptable — the goal is to stop a
 *  loop, not to account for spend. */
const DEMO_ICON_SEARCHES_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;
const iconSearchWindow = new Map<number, { start: number; n: number }>();

/** Count one search for this household and report whether it just went over the hourly ceiling. */
function iconSearchOverLimit(householdId: number): boolean {
  const now = Date.now();
  const w = iconSearchWindow.get(householdId);
  if (w && now - w.start <= HOUR_MS) { w.n++; return w.n > DEMO_ICON_SEARCHES_PER_HOUR; }
  // New window. Demo households are ephemeral (wiped nightly), so sweep stale entries here
  // instead of letting one map entry per household ever created accumulate for the process life.
  if (iconSearchWindow.size > 500) {
    for (const [k, v] of iconSearchWindow) if (now - v.start > HOUR_MS) iconSearchWindow.delete(k);
  }
  iconSearchWindow.set(householdId, { start: now, n: 1 });
  return false;
}

export function iconRoutes(app: FastifyInstance): void {
  /** Get current icon for a canonical name. */
  app.get('/api/canonical/:name/icon', async (req) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const rows = await sql`SELECT icon_url, source, updated_at FROM canonical_meta WHERE canonical_name = ${name}`;
    return rows[0] ?? { icon_url: null, source: null };
  });

  /** Set/replace icon URL for a canonical name. */
  app.put('/api/canonical/:name/icon', async (req, reply) => {
    const name = decodeURIComponent((req.params as { name: string }).name);
    const { icon_url, source } = (req.body ?? {}) as { icon_url?: string | null; source?: string };
    if (icon_url === undefined) return reply.code(400).send({ error: 'icon_url required (or null to clear)' });

    // Clearing the icon must not drop the row: canonical_meta also holds base_unit,
    // track_vorrat, reserve_min, expected_price and the consumption override — a DELETE
    // here would silently reset all of a product's settings.
    if (!icon_url) {
      await sql`
        UPDATE canonical_meta
        SET icon_url = NULL, source = NULL, updated_at = NOW(), updated_by = ${req.user?.id ?? null}
        WHERE canonical_name = ${name}`;
      return { ok: true, cleared: true };
    }
    // Update-then-insert rather than ON CONFLICT: the conflict target differs per env (PK is
    // canonical_name off-demo, (household_id, canonical_name) on the demo — migration 087), so
    // naming one shape raises 42P10 on the other. RLS already scopes the UPDATE to this
    // household. `household_id` is a demo-only column and must be passed explicitly there:
    // it defaults to 1, which on the demo means the operator's household and an RLS failure.
    const uid = req.user?.id ?? null;
    const src = source ?? 'manual';
    const upd = await sql`
      UPDATE canonical_meta
      SET icon_url = ${icon_url}, source = ${src}, updated_at = NOW(), updated_by = ${uid}
      WHERE canonical_name = ${name}`;
    if (upd.count === 0) {
      if (DEMO_MODE) {
        await sql`
          INSERT INTO canonical_meta (canonical_name, icon_url, source, updated_at, updated_by, household_id)
          VALUES (${name}, ${icon_url}, ${src}, NOW(), ${uid}, ${req.user?.household_id ?? 1})`;
      } else {
        await sql`
          INSERT INTO canonical_meta (canonical_name, icon_url, source, updated_at, updated_by)
          VALUES (${name}, ${icon_url}, ${src}, NOW(), ${uid})`;
      }
    }
    return { ok: true };
  });

  /** Image search via SearXNG — returns up to 24 candidates. Every authenticated user may call
   *  it (it backs the icon picker), so it is capped on the demo and never echoes the transport
   *  error — see iconSearchOverLimit above. */
  app.get('/api/icons/search', async (req, reply) => {
    // Bound the caller-supplied query too: it is forwarded verbatim into the operator's SearXNG,
    // and an icon search is a product/store name, never a kilobyte.
    const q = ((req.query as { q?: string }).q ?? '').trim().slice(0, 100);
    if (!q) return reply.code(400).send({ error: 'q required' });
    // The operator is exempt, exactly like every quota in demo/limits.ts — it is their SearXNG.
    if (DEMO_MODE && !req.user?.is_super_admin && iconSearchOverLimit(req.user?.household_id ?? 1)) {
      return reply.code(429).send({ error: 'Zu viele Bildsuchen — bitte später erneut versuchen.' });
    }

    const base = await getConfig('searxng.url');
    // No SearXNG configured (fresh self-host install): say so instead of fetching '/search?…'
    // against the app itself and reporting a confusing transport error.
    if (!base) return reply.code(503).send({ error: 'Bildsuche ist nicht konfiguriert.' });
    const params = new URLSearchParams({
      q,
      format: 'json',
      categories: 'images',
      language: 'de',
      safesearch: '1',
    });
    try {
      const res = await fetch(`${base}/search?${params}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        req.log.error(`icon search: SearXNG HTTP ${res.status}`);
        return reply.code(502).send({ error: 'Bildsuche nicht erreichbar.' });
      }
      const data = (await res.json()) as { results?: SearxImage[] };
      // Prefer thumbnail when present (smaller payload), fall back to img_src
      const hits = (data.results ?? [])
        .slice(0, 24)
        .map(r => ({
          src: r.img_src ?? r.thumbnail_src ?? '',
          thumb: r.thumbnail_src ?? r.img_src ?? '',
          page: r.url ?? '',
          title: r.title ?? '',
          source: r.source ?? '',
        }))
        .filter(r => r.src);
      return { results: hits };
    } catch (e) {
      // Never hand the raw fetch error back: it names the operator's internal SearXNG host and
      // port, and this route is reachable by every user of every household. Log it for the
      // operator, return a flat message.
      req.log.error(`icon search failed: ${(e as Error).message}`);
      return reply.code(502).send({ error: 'Bildsuche nicht erreichbar.' });
    }
  });

  /** Bulk read icons for a list of canonical names — used by Names list and Belege. */
  app.get('/api/canonical/icons', async (req) => {
    const namesParam = (req.query as { names?: string }).names ?? '';
    if (!namesParam) return {};
    const names = namesParam.split(',').filter(Boolean);
    if (!names.length) return {};
    const rows = await sql`
      SELECT canonical_name, icon_url FROM canonical_meta
      WHERE canonical_name IN ${sql(names)} AND icon_url IS NOT NULL
    `;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.canonical_name as string] = r.icon_url as string;
    return out;
  });
}
