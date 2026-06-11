import type { FastifyInstance } from 'fastify';
import sql from '../db.js';

export function receiptRoutes(app: FastifyInstance): void {
  app.get('/api/receipts', async (req) => {
    const q = req.query as { limit?: string; offset?: string; q?: string; from?: string; to?: string; store?: string };
    const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(q.offset ?? '0', 10) || 0;
    const search = (q.q ?? '').trim();
    const like = `%${search}%`;
    const storeLike = q.store ? `%${q.store}%` : null;

    const rows = await sql`
      SELECT e.id, e.datum, e.roh_ladenname, e.bild_pfad, e.gesamt_betrag,
             COUNT(a.id)::int AS item_count
      FROM einkauf e
      LEFT JOIN artikel a ON a.einkauf_id = e.id
      WHERE TRUE
        ${search ? sql`AND (e.roh_ladenname ILIKE ${like} OR EXISTS (
          SELECT 1 FROM artikel ax WHERE ax.einkauf_id = e.id
          AND (ax.name ILIKE ${like} OR ax.canonical_name ILIKE ${like} OR ax.ai_guess ILIKE ${like})
        ))` : sql``}
        ${storeLike ? sql`AND e.roh_ladenname ILIKE ${storeLike}` : sql``}
        ${q.from ? sql`AND e.datum >= ${q.from}` : sql``}
        ${q.to ? sql`AND e.datum <= ${q.to}` : sql``}
      GROUP BY e.id
      ORDER BY e.datum DESC, e.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows;
  });

  app.get('/api/receipts/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });

    const receipts = await sql`
      SELECT id, datum, roh_ladenname, bild_pfad, gesamt_betrag
      FROM einkauf WHERE id = ${id}
    `;
    if (!receipts.length) return reply.code(404).send({ error: 'not found' });

    const artikel = await sql`
      SELECT a.id, a.name, a.menge, a.einheit, a.preis, a.original_text,
             a.ai_guess, a.canonical_name, a.category_path
      FROM artikel a WHERE a.einkauf_id = ${id} ORDER BY a.id
    `;

    const canonicals = [...new Set(artikel.map(a => a.canonical_name).filter(Boolean))] as string[];
    const artikelIds = artikel.map(a => a.id) as number[];

    const canonicalConsumers = canonicals.length ? await sql`
      SELECT cc.canonical_name, cc.family_member_id, cc.is_exclusive
      FROM canonical_consumer cc WHERE cc.canonical_name IN ${sql(canonicals)}
    ` : [];
    const artikelConsumers = artikelIds.length ? await sql`
      SELECT ac.artikel_id, ac.family_member_id
      FROM artikel_consumer ac WHERE ac.artikel_id IN ${sql(artikelIds)}
    ` : [];

    const byCanonical = new Map<string, { id: number; exclusive: boolean }[]>();
    for (const r of canonicalConsumers) {
      const list = byCanonical.get(r.canonical_name) ?? [];
      list.push({ id: r.family_member_id, exclusive: r.is_exclusive });
      byCanonical.set(r.canonical_name, list);
    }
    const byArtikel = new Map<number, number[]>();
    for (const r of artikelConsumers) {
      const list = byArtikel.get(r.artikel_id) ?? [];
      list.push(r.family_member_id);
      byArtikel.set(r.artikel_id, list);
    }

    return {
      ...receipts[0],
      artikel: artikel.map(a => {
        const override = byArtikel.get(a.id as number);
        const canonical = a.canonical_name ? byCanonical.get(a.canonical_name as string) : undefined;
        return {
          ...a,
          consumers: override ?? canonical?.map(c => c.id) ?? [],
          consumers_exclusive: !override && (canonical?.some(c => c.exclusive) ?? false),
          consumers_source: override ? 'artikel' : canonical?.length ? 'canonical' : 'none',
        };
      }),
    };
  });
}
