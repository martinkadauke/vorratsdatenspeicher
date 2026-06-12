import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import Jimp from 'jimp';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { kontoScope, canSeeKonto } from '../auth/konto.js';
import { ocrFromImage } from '../llm/ocr.js';
import { searchFilter, col, numCol, lk, type Frag } from '../lib/search.js';

/** Search config for the receipts list/nav: free text hits the store name or
 *  any of the receipt's items; supports laden:/kategorie: and preis> filters.
 *  `e` is the einkauf alias fragment (the list uses `e`, neighbors `einkauf`). */
function receiptSearch(e: Frag) {
  const itemsWhere = (cond: Frag) =>
    sql`EXISTS (SELECT 1 FROM artikel ax WHERE ax.einkauf_id = ${e}.id AND ${cond})`;
  return {
    text: [
      col(sql`${e}.roh_ladenname`),
      (p: string) => itemsWhere(sql`(${lk(sql`ax.name`, p)} OR ${lk(sql`ax.canonical_name`, p)} OR ${lk(sql`ax.ai_guess`, p)})`),
    ],
    fields: {
      laden: col(sql`${e}.roh_ladenname`),
      kategorie: (p: string) => itemsWhere(lk(sql`ax.category_path`, p)),
    },
    nums: {
      preis: (op: '>' | '<' | '>=' | '<=' | '=', v: number) => itemsWhere(numCol(sql`ax.preis`)(op, v)),
    },
  };
}

/** Local mount where receipt photos are persisted on disk. Host path is
 *  mapped here via the docker volume in deploy/stack.yml. */
const RECEIPTS_LOCAL_PATH = process.env.RECEIPTS_LOCAL_PATH ?? '/receipts';

/** Run vision OCR on a receipt's stored image and replace its line items.
 *  Throws on unusable OCR. Shared by re-OCR and the in-app create-with-photo
 *  flow (the same Claude-vision path n8n uses, just without n8n/Telegram). */
async function ocrAndStore(id: number, bildPfad: string): Promise<{ items: number; confidence: number }> {
  const filename = bildPfad.split('/').pop();
  const source = filename ? path.join(RECEIPTS_LOCAL_PATH, filename) : bildPfad;
  const parsed = await ocrFromImage(source);
  if (!parsed.datum || !parsed.ladenkette) throw new Error('OCR returned no usable receipt data');
  const ladenName = parsed.filiale ? `${parsed.ladenkette} ${parsed.filiale}` : parsed.ladenkette;
  const gesamt = Number.isFinite(parsed.gesamt_betrag) ? parsed.gesamt_betrag : null;
  await sql.begin(async tx => {
    await tx`DELETE FROM artikel WHERE einkauf_id = ${id}`;
    await tx`UPDATE einkauf SET datum = ${parsed.datum}, roh_ladenname = ${ladenName}, gesamt_betrag = ${gesamt} WHERE id = ${id}`;
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
  return { items: parsed.artikel?.length ?? 0, confidence: parsed.confidence };
}

export function receiptRoutes(app: FastifyInstance): void {
  /** Ensure the receipt exists AND the caller may see its account.
   *  Returns false (and sends the response) when not. */
  async function guardReceipt(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, id: number): Promise<boolean> {
    const [row] = await sql`SELECT konto_id FROM einkauf WHERE id = ${id}`;
    if (!row) { void reply.code(404).send({ error: 'not found' }); return false; }
    if (!canSeeKonto(req.user, row.konto_id as number | null)) { void reply.code(403).send({ error: 'forbidden' }); return false; }
    return true;
  }

  app.get('/api/receipts', async (req) => {
    const q = req.query as { limit?: string; offset?: string; q?: string; from?: string; to?: string; store?: string; konto?: string; quelle?: string };
    const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(q.offset ?? '0', 10) || 0;
    const search = (q.q ?? '').trim();
    const storeLike = q.store ? `%${q.store}%` : null;
    const kontoId = q.konto ? parseInt(q.konto, 10) : null;
    const quellen = q.quelle ? q.quelle.split(',').filter(Boolean) : null;

    const rows = await sql`
      SELECT e.id, e.datum, e.roh_ladenname, e.bild_pfad, e.gesamt_betrag, e.geprueft,
             e.konto_id, e.quelle, k.name AS konto_name,
             COUNT(a.id)::int AS item_count
      FROM einkauf e
      LEFT JOIN artikel a ON a.einkauf_id = e.id
      LEFT JOIN konto k ON k.id = e.konto_id
      WHERE TRUE
        ${searchFilter(search, receiptSearch(sql`e`))}
        ${storeLike ? sql`AND e.roh_ladenname ILIKE ${storeLike}` : sql``}
        ${kontoId ? sql`AND e.konto_id = ${kontoId}` : sql``}
        ${quellen ? sql`AND e.quelle IN ${sql(quellen)}` : sql``}
        ${q.from ? sql`AND e.datum >= ${q.from}` : sql``}
        ${q.to ? sql`AND e.datum <= ${q.to}` : sql``}
        ${kontoScope(req.user, sql`e.konto_id`)}
      GROUP BY e.id, k.name
      ORDER BY e.datum DESC, e.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows;
  });

  /** Distinct sources (quelle) the user has visible receipts for. The overview
   *  only shows the source filter when there's more than one. */
  app.get('/api/receipts/quellen', async (req) => {
    const rows = await sql`
      SELECT DISTINCT quelle FROM einkauf e
      WHERE quelle IS NOT NULL ${kontoScope(req.user, sql`e.konto_id`)}
    `;
    return rows.map(r => r.quelle as string);
  });

  /** Manually create a purchase (cash or card). Everything is optional so it's
   *  one tap to log something; details can be filled in later. An optional
   *  photo is sent as base64 and stored alongside scanned receipts. */
  app.post('/api/receipts', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      quelle?: string; roh_ladenname?: string; datum?: string;
      gesamt_betrag?: number | string; konto_id?: number | null;
      photo_base64?: string; photo_mime?: string; ocr?: boolean;
    };
    const quelle = b.quelle === 'bar' ? 'bar' : 'zettel'; // cash → bar; card → normal store receipt
    const datum = (b.datum && /^\d{4}-\d{2}-\d{2}$/.test(b.datum)) ? b.datum : new Date().toISOString().slice(0, 10);
    const laden = (b.roh_ladenname ?? '').toString().trim() || null;
    const gesamtRaw = b.gesamt_betrag;
    const gesamt = gesamtRaw != null && gesamtRaw !== ''
      ? (Number.isFinite(Number(String(gesamtRaw).replace(',', '.'))) ? Number(String(gesamtRaw).replace(',', '.')) : null)
      : null;
    const kontoId = b.konto_id ?? null;
    if (kontoId != null && !canSeeKonto(req.user, kontoId)) return reply.code(403).send({ error: 'forbidden' });

    let bildPfad: string | null = null;
    if (b.photo_base64) {
      const mime = b.photo_mime || 'image/jpeg';
      const ext = mime.includes('png') ? 'png' : 'jpg';
      const data = b.photo_base64.replace(/^data:[^,]+,/, '');
      try {
        const filename = `vds-${crypto.randomUUID()}.${ext}`;
        await writeFile(path.join(RECEIPTS_LOCAL_PATH, filename), Buffer.from(data, 'base64'));
        bildPfad = `/receipts/${filename}`;
      } catch (e) {
        req.log.error(`photo save failed: ${(e as Error).message}`);
      }
    }

    const [row] = await sql`
      INSERT INTO einkauf (datum, roh_ladenname, gesamt_betrag, quelle, konto_id, bild_pfad)
      VALUES (${datum}, ${laden}, ${gesamt}, ${quelle}, ${kontoId}, ${bildPfad})
      RETURNING id
    `;

    // If a photo was uploaded and OCR requested, run the same Claude-vision
    // extraction n8n uses — synchronously so the caller lands on a populated
    // receipt. Best-effort: a failed OCR still leaves the created receipt.
    let ocr: { items: number } | null = null;
    if (b.ocr && bildPfad) {
      try { ocr = await ocrAndStore(row.id as number, bildPfad); }
      catch (e) { req.log.error(`create-ocr failed: ${(e as Error).message}`); }
    }
    return { ok: true, id: row.id, ocr_items: ocr?.items ?? null };
  });

  /** Review-progress across visible receipts (for the overview progress bar).
   *  Respects the active account filter so the bar matches what's shown. */
  app.get('/api/receipts/review-progress', async (req) => {
    const q = req.query as { konto?: string; quelle?: string };
    const kontoId = q.konto ? parseInt(q.konto, 10) : null;
    const quellen = q.quelle ? q.quelle.split(',').filter(Boolean) : null;
    const [row] = await sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE geprueft)::int AS reviewed
      FROM einkauf e
      WHERE TRUE
        ${kontoId ? sql`AND e.konto_id = ${kontoId}` : sql``}
        ${quellen ? sql`AND e.quelle IN ${sql(quellen)}` : sql``}
        ${kontoScope(req.user, sql`e.konto_id`)}
    `;
    return { total: row.total, reviewed: row.reviewed };
  });

  /** Patch receipt-level fields (date, store, total). */
  app.patch('/api/receipts/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardReceipt(req, reply, id)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if ('datum' in body && typeof body.datum === 'string') updates.datum = body.datum;
    if ('roh_ladenname' in body) updates.roh_ladenname = body.roh_ladenname;
    if ('geprueft' in body) updates.geprueft = Boolean(body.geprueft);
    if ('quelle' in body && typeof body.quelle === 'string') updates.quelle = body.quelle;
    if ('konto_id' in body) {
      const v = body.konto_id;
      if (v === null || v === '') updates.konto_id = null;
      else {
        const n = parseInt(String(v), 10);
        if (!Number.isFinite(n)) return reply.code(400).send({ error: 'invalid konto_id' });
        // Only allow moving to an account the caller can see.
        if (!canSeeKonto(req.user, n)) return reply.code(403).send({ error: 'forbidden konto' });
        updates.konto_id = n;
      }
    }
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

  /** Rotate the photo 90° clockwise on disk so the file itself is now
   *  upright — a subsequent re-OCR will see the correctly oriented image.
   *  Requires the host receipts directory to be volume-mounted into the
   *  container at RECEIPTS_LOCAL_PATH (default /receipts). */
  app.post('/api/receipts/:id/rotate', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardReceipt(req, reply, id)) return;
    const rows = await sql`SELECT bild_pfad FROM einkauf WHERE id = ${id}`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    const bildPfad = rows[0].bild_pfad as string | null;
    if (!bildPfad) return reply.code(400).send({ error: 'receipt has no image' });

    // Derive the filename from the URL and look it up under the mount.
    const filename = bildPfad.split('/').pop();
    if (!filename) return reply.code(400).send({ error: 'cannot derive filename from bild_pfad' });
    const localPath = path.join(RECEIPTS_LOCAL_PATH, filename);

    try {
      const image = await Jimp.read(localPath);
      image.rotate(90);
      // writeAsync overwrites in place → mode/ownership preserved.
      // One-time chmod 666 on the host's receipts share is enough for
      // every future rotation (the container is root-squashed via NFS
      // and can't chmod, but mode-666 lets it write).
      await image.writeAsync(localPath);
      req.log.info(`rotated ${localPath} 90° CW`);
      return { ok: true };
    } catch (e) {
      req.log.error(`rotate failed for ${localPath}: ${(e as Error).message}`);
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /** Re-run vision OCR on this receipt's image. Wipes existing artikel
   *  and replaces them with the new extraction. Keeps the einkauf row
   *  (preserves bild_pfad + id), just updates date/store/total. */
  app.post('/api/receipts/:id/reocr', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardReceipt(req, reply, id)) return;

    const rows = await sql`SELECT id, bild_pfad FROM einkauf WHERE id = ${id}`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    const bildPfad = rows[0].bild_pfad as string | null;
    if (!bildPfad) return reply.code(400).send({ error: 'receipt has no image' });

    try {
      const { items, confidence } = await ocrAndStore(id, bildPfad);
      return { ok: true, items, confidence };
    } catch (e) {
      req.log.error(`reocr failed: ${(e as Error).message}`);
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /** Delete a receipt (cascades to its artikel). */
  app.delete('/api/receipts/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardReceipt(req, reply, id)) return;
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
    // datum is a DATE column; coerce to YYYY-MM-DD string so the comparison
    // is not affected by timezone juggling that breaks row-tuple compares.
    const [cur] = await sql`SELECT TO_CHAR(datum, 'YYYY-MM-DD') AS datum, id FROM einkauf WHERE id = ${id}`;
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const datum = cur.datum as string;
    const curId = cur.id as number;

    // Respect the same filters the list used, so prev/next stay within the
    // visible (filtered) set the user is navigating.
    const fq = req.query as { q?: string; store?: string };
    const search = (fq.q ?? '').trim();
    const storeLike = fq.store ? `%${fq.store}%` : null;
    const filter = sql`
      ${searchFilter(search, receiptSearch(sql`einkauf`))}
      ${storeLike ? sql`AND einkauf.roh_ladenname ILIKE ${storeLike}` : sql``}
      ${kontoScope(req.user, sql`einkauf.konto_id`)}
    `;

    // prev = newer (one position earlier in the (datum DESC, id DESC) list)
    const [prev] = await sql`
      SELECT id FROM einkauf
      WHERE (datum > ${datum}::date OR (datum = ${datum}::date AND id > ${curId})) ${filter}
      ORDER BY datum ASC, id ASC LIMIT 1
    `;
    // next = older (one position later in the list)
    const [next] = await sql`
      SELECT id FROM einkauf
      WHERE (datum < ${datum}::date OR (datum = ${datum}::date AND id < ${curId})) ${filter}
      ORDER BY datum DESC, id DESC LIMIT 1
    `;
    return { prev_id: prev?.id ?? null, next_id: next?.id ?? null };
  });

  /** Persist a new line-item order (drag-to-reorder). Body: { order: [ids] }. */
  app.put('/api/receipts/:id/artikel-order', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardReceipt(req, reply, id)) return;
    const { order } = (req.body ?? {}) as { order?: number[] };
    if (!Array.isArray(order) || !order.length) return reply.code(400).send({ error: 'order array required' });

    // Only renumber rows that actually belong to this receipt.
    const owned = new Set((await sql`SELECT id FROM artikel WHERE einkauf_id = ${id}`).map(r => r.id as number));
    await sql.begin(async tx => {
      let pos = 0;
      for (const artikelId of order) {
        if (!owned.has(artikelId)) continue;
        await tx`UPDATE artikel SET sort_order = ${pos++} WHERE id = ${artikelId} AND einkauf_id = ${id}`;
      }
    });
    return { ok: true };
  });

  app.get('/api/receipts/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });

    const receipts = await sql`
      SELECT e.id, e.datum, e.roh_ladenname, e.bild_pfad, e.gesamt_betrag, e.geprueft,
             e.konto_id, e.quelle, k.name AS konto_name
      FROM einkauf e LEFT JOIN konto k ON k.id = e.konto_id
      WHERE e.id = ${id}
    `;
    if (!receipts.length) return reply.code(404).send({ error: 'not found' });
    if (!canSeeKonto(req.user, receipts[0].konto_id as number | null)) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const artikel = await sql`
      SELECT a.id, a.name, a.menge, a.einheit, a.preis, a.original_text,
             a.ai_guess, a.canonical_name, a.category_path
      FROM artikel a WHERE a.einkauf_id = ${id}
      ORDER BY COALESCE(a.sort_order, a.id), a.id
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
