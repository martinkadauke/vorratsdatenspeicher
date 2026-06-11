import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
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

    if (!icon_url) {
      await sql`DELETE FROM canonical_meta WHERE canonical_name = ${name}`;
      return { ok: true, cleared: true };
    }
    await sql`
      INSERT INTO canonical_meta (canonical_name, icon_url, source, updated_at, updated_by)
      VALUES (${name}, ${icon_url}, ${source ?? 'manual'}, NOW(), ${req.user?.id ?? null})
      ON CONFLICT (canonical_name) DO UPDATE
        SET icon_url = EXCLUDED.icon_url, source = EXCLUDED.source,
            updated_at = NOW(), updated_by = EXCLUDED.updated_by
    `;
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
