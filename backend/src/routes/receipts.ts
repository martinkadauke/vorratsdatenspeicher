import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { ocrFromUrl } from '../llm/ocr.js';

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

  /** Patch receipt-level fields (date, store, total). */
  app.patch('/api/receipts/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if ('datum' in body && typeof body.datum === 'string') updates.datum = body.datum;
    if ('roh_ladenname' in body) updates.roh_ladenname = body.roh_ladenname;
    if ('gesamt_betrag' in body) {
      const v = body.gesamt_betrag;
      if (v === null || v === '') updates.gesamt_betrag = null;
      else {
        const n = parseFloat(String(v).replace(',', '.'));
        if (!Number.isFinite(n)) return reply.code(400).send({ error: 'invalid gesamt_betrag' });
        updates.gesamt_betrag = n;
      }
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'no patchable fields' });
    const rows = await sql`UPDATE einkauf SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  /** Re-run vision OCR on this receipt's image. Wipes existing artikel
   *  and replaces them with the new extraction. Keeps the einkauf row
   *  (preserves bild_pfad + id), just updates date/store/total. */
  app.post('/api/receipts/:id/reocr', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });

    const rows = await sql`SELECT id, bild_pfad FROM einkauf WHERE id = ${id}`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    const bildPfad = rows[0].bild_pfad as string | null;
    if (!bildPfad) return reply.code(400).send({ error: 'receipt has no image' });

    try {
      const parsed = await ocrFromUrl(bildPfad);
      if (!parsed.datum || !parsed.ladenkette) {
        return reply.code(422).send({ error: 'OCR returned no usable receipt data', confidence: parsed.confidence });
      }
      const ladenName = parsed.filiale ? `${parsed.ladenkette} ${parsed.filiale}` : parsed.ladenkette;
      const gesamt = Number.isFinite(parsed.gesamt_betrag) ? parsed.gesamt_betrag : null;

      await sql.begin(async tx => {
        await tx`DELETE FROM artikel WHERE einkauf_id = ${id}`;
        await tx`
          UPDATE einkauf
          SET datum = ${parsed.datum}, roh_ladenname = ${ladenName}, gesamt_betrag = ${gesamt}
          WHERE id = ${id}
        `;
        for (const a of parsed.artikel ?? []) {
          await tx`
            INSERT INTO artikel
              (einkauf_id, name, menge, einheit, preis, kategorie, original_text, ai_guess, canonical_name)
            VALUES
              (${id}, ${a.name ?? a.original_text ?? ''}, ${a.menge ?? null}, ${a.einheit ?? ''},
               ${a.preis ?? null}, ${a.kategorie ?? ''}, ${a.original_text ?? a.name ?? ''},
               ${a.ai_guess ?? a.name ?? ''}, NULL)
          `;
        }
      });
      return {
        ok: true,
        items: parsed.artikel?.length ?? 0,
        confidence: parsed.confidence,
        usage: parsed.usage ?? null,
      };
    } catch (e) {
      req.log.error(`reocr failed: ${(e as Error).message}`);
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /** Delete a receipt (cascades to its artikel). */
  app.delete('/api/receipts/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const rows = await sql`DELETE FROM einkauf WHERE id = ${id} RETURNING id, bild_pfad`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true, bild_pfad: rows[0].bild_pfad };
  });

  /** Find the previous/next receipt in the canonical sort order
   *  (datum DESC, id DESC) — same as /api/receipts. Used for arrow-key
   *  and swipe navigation from the detail page. */
  app.get('/api/receipts/:id/neighbors', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const [cur] = await sql`SELECT datum, id FROM einkauf WHERE id = ${id}`;
    if (!cur) return reply.code(404).send({ error: 'not found' });
    // prev = newer (sorts before in DESC order)
    const [prev] = await sql`
      SELECT id FROM einkauf
      WHERE (datum, id) > (${cur.datum}, ${cur.id})
      ORDER BY datum ASC, id ASC LIMIT 1
    `;
    // next = older (sorts after in DESC order)
    const [next] = await sql`
      SELECT id FROM einkauf
      WHERE (datum, id) < (${cur.datum}, ${cur.id})
      ORDER BY datum DESC, id DESC LIMIT 1
    `;
    return { prev_id: prev?.id ?? null, next_id: next?.id ?? null };
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
