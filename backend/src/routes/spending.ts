import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';

interface ArtikelRow {
  id: number;
  preis: number | null;
  canonical_name: string | null;
  category_path: string | null;
  datum: string;
}

const UNCAT = 'Sonstiges/Unkategorisiert';

function ymOf(dateStr: string): string {
  return String(dateStr).slice(0, 7);
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12 + 12) % 12 + 1 };
}

function ymKey(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Build consumer share resolver: returns the price share of an artikel for a member filter. */
async function buildShareResolver(member: number | null): Promise<(a: ArtikelRow) => number> {
  if (member === null) return (a) => Number(a.preis ?? 0);

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

  return (a) => {
    const tagged = byArtikel.get(a.id) ?? (a.canonical_name ? byCanonical.get(a.canonical_name) : undefined);
    if (!tagged || !tagged.length) return 0;
    if (!tagged.includes(member)) return 0;
    return Number(a.preis ?? 0) / tagged.length;
  };
}

/** All ancestor paths of a category path, including itself and the '' total. */
function pathChain(path: string): string[] {
  const parts = path.split('/');
  const chain = [''];
  for (let i = 1; i <= parts.length; i++) chain.push(parts.slice(0, i).join('/'));
  return chain;
}

export function spendingRoutes(app: FastifyInstance): void {
  app.get('/api/spending/tree', async (req) => {
    const q = req.query as { year?: string; month?: string; member?: string; lang?: string };
    const now = new Date();
    const year = parseInt(q.year ?? '', 10) || now.getFullYear();
    const month = parseInt(q.month ?? '', 10) || now.getMonth() + 1;
    const member = q.member ? parseInt(q.member, 10) : null;
    const lang = q.lang ?? req.user?.preferred_lang ?? 'de';

    const selectedYm = ymKey(year, month);
    const avgStart = addMonths(year, month, -3);
    const rangeStart = `${ymKey(avgStart.year, avgStart.month)}-01`;
    const next = addMonths(year, month, 1);
    const rangeEnd = `${ymKey(next.year, next.month)}-01`;

    const categories = await sql`
      SELECT path, parent_path, display, display_en, level, sort_order, emoji, is_meta
      FROM category ORDER BY sort_order, path
    `;
    const metaPaths = new Set(categories.filter(c => c.is_meta).map(c => c.path as string));

    const artikel = (await sql`
      SELECT a.id, a.preis, a.canonical_name, a.category_path, e.datum::text AS datum
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE e.datum >= ${rangeStart} AND e.datum < ${rangeEnd}
        ${kontoScope(req.user, sql`e.konto_id`)}
    `) as unknown as ArtikelRow[];

    const share = await buildShareResolver(member);

    // sums[path][ym] = eur
    const sums = new Map<string, Map<string, number>>();
    for (const a of artikel) {
      const path = a.category_path ?? UNCAT;
      if (metaPaths.has(path) || path.startsWith('Meta/') || path === 'Meta') continue;
      const eur = share(a);
      if (!eur) continue;
      const ym = ymOf(a.datum);
      for (const p of pathChain(path)) {
        let perYm = sums.get(p);
        if (!perYm) { perYm = new Map(); sums.set(p, perYm); }
        perYm.set(ym, (perYm.get(ym) ?? 0) + eur);
      }
    }

    const goals = await sql`
      SELECT category_path, goal_eur FROM spending_goal WHERE year = ${year} AND month = ${month}
    `;
    const goalMap = new Map(goals.map(g => [g.category_path as string, Number(g.goal_eur)]));

    const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
    const daysElapsed = isCurrentMonth ? now.getDate() : 1;
    const daysTotal = new Date(year, month, 0).getDate();
    const projFactor = isCurrentMonth ? daysTotal / Math.max(daysElapsed, 1) : 1;

    const prevYms = [-1, -2, -3].map(d => {
      const p = addMonths(year, month, d);
      return ymKey(p.year, p.month);
    });

    const node = (path: string) => {
      const perYm = sums.get(path);
      const mtd = perYm?.get(selectedYm) ?? 0;
      const avg3 = prevYms.reduce((acc, ym) => acc + (perYm?.get(ym) ?? 0), 0) / 3;
      return {
        mtd: round2(mtd),
        projection: round2(mtd * projFactor),
        avg3: round2(avg3),
        goal: goalMap.get(path) ?? null,
      };
    };

    return {
      year, month,
      is_current_month: isCurrentMonth,
      days_elapsed: isCurrentMonth ? daysElapsed : daysTotal,
      days_total: daysTotal,
      total: { path: '', label: lang === 'en' ? 'Total' : 'Gesamt', level: 0, ...node('') },
      nodes: categories
        .filter(c => !c.is_meta)
        .map(c => ({
          path: c.path,
          parent_path: c.parent_path,
          label: lang === 'en' && c.display_en ? c.display_en : c.display,
          emoji: c.emoji,
          level: c.level,
          sort_order: c.sort_order,
          ...node(c.path as string),
        })),
    };
  });

  app.get('/api/spending/history', async (req) => {
    const q = req.query as { path?: string; months?: string; member?: string };
    const path = q.path ?? '';
    const months = Math.min(parseInt(q.months ?? '12', 10) || 12, 36);
    const member = q.member ? parseInt(q.member, 10) : null;

    const now = new Date();
    const start = addMonths(now.getFullYear(), now.getMonth() + 1, -(months - 1));
    const rangeStart = `${ymKey(start.year, start.month)}-01`;

    const artikel = (await sql`
      SELECT a.id, a.preis, a.canonical_name, a.category_path, e.datum::text AS datum
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE e.datum >= ${rangeStart}
        ${kontoScope(req.user, sql`e.konto_id`)}
    `) as unknown as ArtikelRow[];

    const share = await buildShareResolver(member);
    const byYm = new Map<string, number>();
    for (const a of artikel) {
      const p = a.category_path ?? UNCAT;
      if (p === 'Meta' || p.startsWith('Meta/')) continue;
      if (path && p !== path && !p.startsWith(path + '/')) continue;
      const eur = share(a);
      if (!eur) continue;
      const ym = ymOf(a.datum);
      byYm.set(ym, (byYm.get(ym) ?? 0) + eur);
    }

    const out: { ym: string; spend: number }[] = [];
    for (let i = 0; i < months; i++) {
      const p = addMonths(start.year, start.month, i);
      const ym = ymKey(p.year, p.month);
      out.push({ ym, spend: round2(byYm.get(ym) ?? 0) });
    }
    return out;
  });

  app.get('/api/spending/items', async (req) => {
    const q = req.query as { path?: string; year?: string; month?: string; member?: string };
    const now = new Date();
    const year = parseInt(q.year ?? '', 10) || now.getFullYear();
    const month = parseInt(q.month ?? '', 10) || now.getMonth() + 1;
    const path = q.path ?? '';
    const member = q.member ? parseInt(q.member, 10) : null;

    const rangeStart = `${ymKey(year, month)}-01`;
    const next = addMonths(year, month, 1);
    const rangeEnd = `${ymKey(next.year, next.month)}-01`;

    const rows = await sql`
      SELECT a.id, a.name, a.canonical_name, a.category_path, a.preis, a.menge, a.einheit,
             e.id AS einkauf_id, e.datum::text AS datum, e.roh_ladenname
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE e.datum >= ${rangeStart} AND e.datum < ${rangeEnd}
        AND (a.category_path IS NULL OR a.category_path NOT LIKE 'Meta/%')
        ${path ? sql`AND (a.category_path = ${path} OR a.category_path LIKE ${path + '/%'})` : sql``}
        ${kontoScope(req.user, sql`e.konto_id`)}
      ORDER BY a.preis DESC NULLS LAST
    `;

    if (member === null) return rows;
    const share = await buildShareResolver(member);
    return rows
      .map(r => ({ ...r, member_share: round2(share(r as unknown as ArtikelRow)) }))
      .filter(r => r.member_share > 0);
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
