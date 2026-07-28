import type { FastifyInstance } from 'fastify';
import sql, { DEMO_MODE } from '../db.js';
import { getConfig } from '../config.js';

interface SearxImage { thumbnail_src?: string; img_src?: string; url?: string; title?: string; source?: string }

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

  /** Image search via SearXNG — returns up to 24 candidates. */
  app.get('/api/icons/search', async (req, reply) => {
    const q = ((req.query as { q?: string }).q ?? '').trim();
    if (!q) return reply.code(400).send({ error: 'q required' });

    const base = await getConfig('searxng.url');
    const params = new URLSearchParams({
      q,
      format: 'json',
      categories: 'images',
      language: 'de',
      safesearch: '1',
    });
    try {
      const res = await fetch(`${base}/search?${params}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return reply.code(502).send({ error: `SearXNG HTTP ${res.status}` });
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
      return reply.code(502).send({ error: (e as Error).message });
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
