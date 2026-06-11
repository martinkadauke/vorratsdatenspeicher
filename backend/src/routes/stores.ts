import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

/** Normalize free-text store name into a stable key for grouping.
 *  "LIDL", "Lidl", "Lidl GmbH" → "lidl". */
function normalizeStore(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/gmbh|kg|ag|co\.?|&|\bservice\b/gi, '')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim()
    .split(/\s+/)[0] ?? '';
}

export function storeRoutes(app: FastifyInstance): void {
  /** List all stores ever seen with receipt count + total spend. */
  app.get('/api/stores', async () => {
    const rows = await sql`
      SELECT roh_ladenname, COUNT(*)::int AS receipts, SUM(gesamt_betrag)::numeric(10,2) AS total
      FROM einkauf
      WHERE roh_ladenname IS NOT NULL
      GROUP BY roh_ladenname
      ORDER BY receipts DESC
    `;
    // Group by normalized name in JS so "LIDL" + "Lidl GmbH" merge
    const grouped = new Map<string, { display: string; receipts: number; total: number; raw: string[] }>();
    for (const r of rows) {
      const key = normalizeStore(r.roh_ladenname as string);
      if (!key) continue;
      const display = String(r.roh_ladenname).replace(/\s+(gmbh|kg|ag).*/i, '');
      const e = grouped.get(key) ?? { display, receipts: 0, total: 0, raw: [] };
      e.receipts += r.receipts;
      e.total += Number(r.total ?? 0);
      e.raw.push(r.roh_ladenname as string);
      grouped.set(key, e);
    }
    return [...grouped.entries()]
      .map(([key, v]) => ({ key, display: v.display, receipts: v.receipts, total: v.total, raw: v.raw }))
      .sort((a, b) => b.receipts - a.receipts);
  });

  /** Price history of a canonical_name per store.
   *  Returns avg price per (store, month) plus the cheapest store overall. */
  app.get('/api/stores/price-history', async (req, reply) => {
    const name = (req.query as { canonical?: string }).canonical;
    if (!name) return reply.code(400).send({ error: 'canonical required' });

    const rows = await sql`
      SELECT
        e.roh_ladenname AS store,
        to_char(e.datum, 'YYYY-MM') AS ym,
        AVG(a.preis)::numeric(10,2) AS avg_eur,
        MIN(a.preis)::numeric(10,2) AS min_eur,
        COUNT(*)::int AS n
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.canonical_name = ${name}
        AND a.preis IS NOT NULL
        AND a.preis > 0
      GROUP BY e.roh_ladenname, ym
      ORDER BY ym DESC, store
    `;

    // group by normalized store key
    const byStore = new Map<string, { display: string; points: { ym: string; avg: number; min: number; n: number }[] }>();
    for (const r of rows) {
      const key = normalizeStore(r.store as string);
      if (!key) continue;
      const e = byStore.get(key) ?? { display: r.store as string, points: [] };
      e.points.push({ ym: r.ym as string, avg: Number(r.avg_eur), min: Number(r.min_eur), n: r.n });
      byStore.set(key, e);
    }

    const stores = [...byStore.entries()].map(([key, v]) => {
      const avgPrice = v.points.reduce((s, p) => s + p.avg * p.n, 0) /
                       v.points.reduce((s, p) => s + p.n, 0);
      return { key, display: v.display, avg_eur: round2(avgPrice), points: v.points };
    });

    const cheapest = [...stores].sort((a, b) => a.avg_eur - b.avg_eur)[0] ?? null;
    return { canonical: name, stores, cheapest };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
