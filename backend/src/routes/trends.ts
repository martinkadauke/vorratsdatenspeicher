import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';

interface WeekRow {
  ym_week: string;
  spend: number;
  category_path: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function trendsRoutes(app: FastifyInstance): void {
  /** Week-vs-week trend: spend per ISO week for the last 8 weeks.
   *  Useful for "Mint-style" anomaly highlighting on the dashboard. */
  app.get('/api/trends/weekly', async (req) => {
    const q = req.query as { member?: string };
    const member = q.member ? parseInt(q.member, 10) : null;

    const since = new Date();
    since.setDate(since.getDate() - 8 * 7);
    const sinceStr = since.toISOString().slice(0, 10);

    const rows = (await sql`
      SELECT a.id, a.preis, a.canonical_name, a.category_path,
             e.datum::text AS datum
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE e.datum >= ${sinceStr}
        AND (a.category_path IS NULL OR a.category_path NOT LIKE 'Meta/%')
        ${kontoScope(req.user, sql`e.konto_id`)}
    `) as unknown as { id: number; preis: string | null; canonical_name: string | null; datum: string }[];

    // Optional member filter using consumer maps
    let share: (a: { id: number; preis: unknown; canonical_name: string | null }) => number;
    if (member === null) {
      share = (a) => Number(a.preis ?? 0);
    } else {
      const canonicalRows = await sql`SELECT canonical_name, family_member_id FROM canonical_consumer`;
      const artikelRows = await sql`SELECT artikel_id, family_member_id FROM artikel_consumer`;
      const byCanonical = new Map<string, number[]>();
      for (const r of canonicalRows) {
        const list = byCanonical.get(r.canonical_name) ?? [];
        list.push(r.family_member_id);
        byCanonical.set(r.canonical_name, list);
      }
      const byArtikel = new Map<number, number[]>();
      for (const r of artikelRows) {
        const list = byArtikel.get(r.artikel_id) ?? [];
        list.push(r.family_member_id);
        byArtikel.set(r.artikel_id, list);
      }
      share = (a) => {
        const tagged = byArtikel.get(a.id) ?? (a.canonical_name ? byCanonical.get(a.canonical_name) : undefined);
        if (!tagged?.length || !tagged.includes(member)) return 0;
        return Number(a.preis ?? 0) / tagged.length;
      };
    }

    const byWeek = new Map<string, number>();
    for (const r of rows) {
      const eur = share(r);
      if (!eur) continue;
      const w = isoWeekKey(new Date(r.datum));
      byWeek.set(w, (byWeek.get(w) ?? 0) + eur);
    }

    // build 8 weeks ending now, oldest → newest
    const weeks: { week: string; spend: number }[] = [];
    const today = new Date();
    for (let i = 7; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i * 7);
      const w = isoWeekKey(d);
      weeks.push({ week: w, spend: round2(byWeek.get(w) ?? 0) });
    }

    const current = weeks[weeks.length - 1];
    const previous = weeks[weeks.length - 2] ?? { week: '', spend: 0 };
    const avg4 = weeks.slice(-5, -1).reduce((s, w) => s + w.spend, 0) / 4;
    const delta_pct = previous.spend > 0
      ? round2(((current.spend - previous.spend) / previous.spend) * 100)
      : null;
    const anomaly = avg4 > 0 && current.spend > avg4 * 1.35;

    return { weeks, current, previous, avg4: round2(avg4), delta_pct, anomaly };
  });

  /** Top categories where the current month is way over the 3-month average.
   *  Returns rows ordered by % overshoot, capped at 5. */
  app.get('/api/trends/overspend', async (req) => {
    const q = req.query as { lang?: string };
    const lang = q.lang ?? req.user?.preferred_lang ?? 'de';
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    const rows = (await sql`
      WITH cur AS (
        SELECT
          COALESCE(a.category_path, 'Sonstiges/Unkategorisiert') AS path,
          SUM(a.preis) AS spend
        FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
        WHERE EXTRACT(YEAR FROM e.datum)::int = ${year}
          AND EXTRACT(MONTH FROM e.datum)::int = ${month}
          AND (a.category_path IS NULL OR a.category_path NOT LIKE 'Meta/%')
          ${kontoScope(req.user, sql`e.konto_id`)}
        GROUP BY path
      ),
      prev AS (
        SELECT
          COALESCE(a.category_path, 'Sonstiges/Unkategorisiert') AS path,
          to_char(e.datum, 'YYYY-MM') AS ym,
          SUM(a.preis) AS spend
        FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
        WHERE e.datum < date_trunc('month', CURRENT_DATE)
          AND e.datum >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
          AND (a.category_path IS NULL OR a.category_path NOT LIKE 'Meta/%')
          ${kontoScope(req.user, sql`e.konto_id`)}
        GROUP BY path, ym
      ),
      avg3 AS (
        SELECT path, AVG(spend) AS avg_spend FROM prev GROUP BY path
      )
      SELECT c.path, c.spend::numeric(10,2) AS spend,
             COALESCE(a.avg_spend, 0)::numeric(10,2) AS avg3,
             cat.display, cat.display_en
      FROM cur c
      LEFT JOIN avg3 a ON a.path = c.path
      LEFT JOIN category cat ON cat.path = c.path
      WHERE a.avg_spend IS NOT NULL
        AND a.avg_spend > 5
        AND c.spend > a.avg_spend * 1.25
      ORDER BY (c.spend / NULLIF(a.avg_spend, 0)) DESC
      LIMIT 5
    `).map(r => ({
      path: r.path as string,
      label: (lang === 'en' && r.display_en) ? r.display_en : (r.display ?? r.path),
      spend: Number(r.spend),
      avg3: Number(r.avg3),
      overshoot_pct: round2((Number(r.spend) / Number(r.avg3) - 1) * 100),
    }));

    return rows;
  });
}
