import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(',') + '\n';
}

export function exportRoutes(app: FastifyInstance): void {
  /** All artikel as CSV, joined with receipt metadata. Optional date range. */
  app.get('/api/exports/artikel.csv', async (req, reply) => {
    const q = req.query as { from?: string; to?: string };

    const rows = await sql`
      SELECT
        a.id, e.datum::text AS datum, e.roh_ladenname AS laden, e.id AS einkauf_id,
        a.name, a.canonical_name, a.category_path,
        a.menge, a.einheit, a.preis,
        a.original_text, a.ai_guess
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE TRUE
        ${q.from ? sql`AND e.datum >= ${q.from}` : sql``}
        ${q.to ? sql`AND e.datum <= ${q.to}` : sql``}
        ${kontoScope(req.user, sql`e.konto_id`)}
      ORDER BY e.datum DESC, e.id DESC, a.id ASC
    `;

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="vds-artikel-${new Date().toISOString().slice(0, 10)}.csv"`);

    let out = '﻿'; // BOM for Excel to detect UTF-8
    out += csvRow([
      'id', 'datum', 'laden', 'einkauf_id',
      'name', 'canonical_name', 'category_path',
      'menge', 'einheit', 'preis_eur',
      'original_text', 'ai_guess',
    ]);
    for (const r of rows) {
      out += csvRow([
        r.id, r.datum, r.laden, r.einkauf_id,
        r.name, r.canonical_name, r.category_path,
        r.menge, r.einheit, r.preis,
        r.original_text, r.ai_guess,
      ]);
    }
    return out;
  });

  /** Receipts (one row per receipt) as CSV. */
  app.get('/api/exports/receipts.csv', async (req, reply) => {
    const q = req.query as { from?: string; to?: string };
    const rows = await sql`
      SELECT e.id, e.datum::text AS datum, e.roh_ladenname AS laden, e.gesamt_betrag,
             COUNT(a.id)::int AS artikel_count
      FROM einkauf e LEFT JOIN artikel a ON a.einkauf_id = e.id
      WHERE TRUE
        ${q.from ? sql`AND e.datum >= ${q.from}` : sql``}
        ${q.to ? sql`AND e.datum <= ${q.to}` : sql``}
        ${kontoScope(req.user, sql`e.konto_id`)}
      GROUP BY e.id
      ORDER BY e.datum DESC, e.id DESC
    `;

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="vds-belege-${new Date().toISOString().slice(0, 10)}.csv"`);

    let out = '﻿';
    out += csvRow(['id', 'datum', 'laden', 'gesamt_eur', 'artikel_count']);
    for (const r of rows) {
      out += csvRow([r.id, r.datum, r.laden, r.gesamt_betrag, r.artikel_count]);
    }
    return out;
  });

  /** Monthly category spend as CSV — pivot-ready for Excel. */
  app.get('/api/exports/monthly.csv', async (req, reply) => {
    const rows = await sql`
      SELECT
        to_char(e.datum, 'YYYY-MM') AS ym,
        COALESCE(a.category_path, 'Sonstiges/Unkategorisiert') AS category_path,
        SUM(a.preis)::numeric(10,2) AS spend_eur,
        COUNT(*)::int AS items
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.preis IS NOT NULL
        AND (a.category_path IS NULL OR a.category_path NOT LIKE 'Meta/%')
        ${kontoScope(req.user, sql`e.konto_id`)}
      GROUP BY ym, category_path
      ORDER BY ym DESC, category_path
    `;

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="vds-monthly-${new Date().toISOString().slice(0, 10)}.csv"`);

    let out = '﻿';
    out += csvRow(['ym', 'category_path', 'spend_eur', 'items']);
    for (const r of rows) {
      out += csvRow([r.ym, r.category_path, r.spend_eur, r.items]);
    }
    return out;
  });
}
