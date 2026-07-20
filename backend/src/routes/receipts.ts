import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import Jimp from 'jimp';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { kontoScope, canSeeKonto } from '../auth/konto.js';
import { accountHasStatements } from './konten.js';
import { ocrFromImage, type OcrResult } from '../llm/ocr.js';
import { searchFilter, col, numCol, lk, type Frag } from '../lib/search.js';
import { cleanMatch } from '../lib/canonicalMatch.js';
import { ocrKey, loadAliasMap, loadUserAliasKeys, recordAliases } from '../lib/canonicalAlias.js';
import { triggerChurnAfterOcr } from '../churner/index.js';

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
      // Also match the linked bank booking's text, so a receipt filed under one
      // name (e.g. "Scriptum") is found by its bank counterparty ("nexi germany").
      (p: string) => sql`EXISTS (SELECT 1 FROM bank_tx bt WHERE bt.id = ${e}.bank_tx_id AND (${lk(sql`bt.counterparty`, p)} OR ${lk(sql`bt.description`, p)}))`,
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

/** Turn a verbose OCR'd store name into "Chain City", e.g.
 *  "ALDI Süd Graethäuser Straße 15, 72810 Gomaringen" → "ALDI Gomaringen".
 *  Chain = first word of the chain name (drops "Süd"/"Nord"/legal suffix);
 *  city = the place after the 5-digit ZIP, else after the last comma. Falls
 *  back to a lightly-cleaned full name when no address is present. */
export function cleanLadenName(ladenkette: string | null, filiale: string | null): string {
  const k = (ladenkette ?? '').trim();
  const f = (filiale ?? '').trim();
  const full = (f ? `${k} ${f}` : k).trim();
  if (!full) return full;
  const chain = (k.split(/[\s,]+/)[0] || full.split(/[\s,]+/)[0] || '').trim();

  let city: string | null = null;
  const zip = full.match(/\d{5}\s+([^\d,]+)/); // "72810 Gomaringen" → "Gomaringen"
  if (zip) city = zip[1].trim();
  else if (full.includes(',')) {
    const last = full.split(',').pop()!.trim().replace(/^\d{5}\s+/, '');
    if (/^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]+$/.test(last)) city = last;
  }

  if (city && chain) return `${chain} ${city}`.replace(/\s+/g, ' ').trim();
  return full.replace(/\b(Süd|Nord|Ost|West|GmbH|Co\.?\s*KG|KG|AG|SE|e\.?\s*K\.?)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** Persist a parsed OCR/extraction result onto an existing receipt: replace its
 *  line items and fill in store/date/total without wiping known values, inheriting
 *  canonical names from learned aliases + guarded deterministic matches. Shared by
 *  the image path (ocrAndStore) and the e-mail-text import path. A missing DATE is
 *  not fatal — it flags date_uncertain so the user confirms before finalising; only
 *  a fully empty result throws. */
export async function storeOcrResult(id: number, parsed: OcrResult): Promise<{ items: number; confidence: number }> {
  if (!parsed.ladenkette && !(parsed.artikel?.length)) throw new Error('OCR returned no usable receipt data');
  const ladenName = cleanLadenName(parsed.ladenkette, parsed.filiale);
  const gesamt = Number.isFinite(parsed.gesamt_betrag) ? parsed.gesamt_betrag : null;
  const dateUncertain = !parsed.datum; // OCR found no date → user must confirm it
  // Inherit known canonical names already at scan time: first the learned alias
  // memory (exact OCR repeat → instant), then deterministic whole-word match.
  const existing = (await sql`SELECT DISTINCT canonical_name FROM artikel WHERE canonical_name IS NOT NULL`)
    .map(r => r.canonical_name as string);
  const aliases = await loadAliasMap();
  const userKeys = await loadUserAliasKeys();
  const learn: [string | null, string][] = [];
  await sql.begin(async tx => {
    await tx`DELETE FROM artikel WHERE einkauf_id = ${id}`;
    // COALESCE so an OCR that misses a field doesn't wipe an existing value
    // (datum is NOT NULL — keep the receipt's current date when OCR found none).
    await tx`
      UPDATE einkauf SET
        datum         = COALESCE(${parsed.datum ?? null}::date, datum),
        roh_ladenname = COALESCE(NULLIF(${ladenName}, ''), roh_ladenname),
        gesamt_betrag = COALESCE(${gesamt}, gesamt_betrag),
        date_uncertain = ${dateUncertain}
      WHERE id = ${id}`;
    for (const a of parsed.artikel ?? []) {
      const key = ocrKey(a.original_text ?? a.name);
      const fromAlias = aliases.get(key);
      // Guarded: only inherit a deterministic match when it's unambiguous (no other
      // significant product noun), else leave NULL for AI + Prüfen review. The guard
      // uses the RECEIPT text only, so a wrong ai_guess can't block a clean match.
      const canon = fromAlias ?? cleanMatch([a.original_text, a.name, a.ai_guess], existing, [a.original_text, a.name]);
      if (canon && !fromAlias) learn.push([a.original_text ?? a.name ?? null, canon]); // remember new matches
      const fromUser = !!fromAlias && userKeys.has(key); // inherited a user correction
      await tx`
        INSERT INTO artikel
          (einkauf_id, name, menge, einheit, preis, kategorie, original_text, ai_guess, canonical_name, user_corrected, ocr_key)
        VALUES
          (${id}, ${a.name ?? a.original_text ?? ''}, ${a.menge ?? 1}, ${a.einheit ?? ''},
           ${a.preis ?? null}, ${a.kategorie ?? ''}, ${a.original_text ?? a.name ?? ''},
           ${a.ai_guess ?? a.name ?? ''}, ${canon}, ${fromUser}, ${key})
      `;
    }
  });
  await recordAliases(learn);
  // Kick a (debounced, config-gated) churn pass so the raw OCR items get canonicalized
  // /categorized/deduped right away instead of waiting for the nightly run. Fire-and-forget.
  void triggerChurnAfterOcr().catch(err => console.error('[churner] post-OCR trigger failed:', (err as Error).message));
  return { items: parsed.artikel?.length ?? 0, confidence: parsed.confidence };
}

/** Run vision OCR on a receipt's stored image/PDF and replace its line items.
 *  Throws on unusable OCR. Shared by re-OCR, the in-app create-with-photo flow,
 *  and the e-mail importer (the same Claude-vision path n8n uses). */
export async function ocrAndStore(id: number, bildPfad: string, hint?: string | null): Promise<{ items: number; confidence: number }> {
  const filename = bildPfad.split('/').pop();
  const source = filename ? path.join(RECEIPTS_LOCAL_PATH, filename) : bildPfad;
  const parsed = await ocrFromImage(source, hint);
  return storeOcrResult(id, parsed);
}

/** Best-effort scrub of e-mail HTML before it's shown in a sandboxed iframe.
 *  The iframe sandbox (no allow-scripts) is the real XSS guard; this strips the
 *  obvious active content as defence in depth. */
function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<\s*(?:iframe|object|embed|link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

export function receiptRoutes(app: FastifyInstance): void {
  /** Ensure the receipt exists AND the caller may see its account.
   *  Returns false (and sends the response) when not. */
  async function guardReceipt(req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, id: number): Promise<boolean> {
    const [row] = await sql`SELECT private_for_user_id FROM einkauf WHERE id = ${id}`;
    if (!row) { void reply.code(404).send({ error: 'not found' }); return false; }
    // Per-receipt privacy: a private receipt is reachable by its owner, or by a
    // super-admin (sees_all_konten = "kann alles sehen", no exception).
    const pf = row.private_for_user_id as number | null;
    if (pf !== null && pf !== (req.user?.id ?? null) && !req.user?.sees_all_konten) { void reply.code(403).send({ error: 'forbidden' }); return false; }
    return true;
  }

  app.get('/api/receipts', async (req) => {
    const q = req.query as { limit?: string; offset?: string; q?: string; from?: string; to?: string; store?: string; konto?: string; quelle?: string; hidden?: string };
    const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(q.offset ?? '0', 10) || 0;
    const search = (q.q ?? '').trim();
    const storeLike = q.store ? `%${q.store}%` : null;
    const kontoId = q.konto ? parseInt(q.konto, 10) : null;
    const quellen = q.quelle ? q.quelle.split(',').filter(Boolean) : null;
    // "Nur versteckte": show ONLY private receipts. Meaningful for super-admins
    // (kontoScope is bypassed for them, so this surfaces everyone's private ones);
    // for a normal user kontoScope still limits it to their own private receipts.
    const onlyHidden = q.hidden === '1';

    const rows = await sql`
      SELECT e.id, e.datum, e.roh_ladenname, e.bild_pfad, e.gesamt_betrag, e.geprueft,
             e.konto_id, e.quelle, k.name AS konto_name, k.account_type, e.ocr_pending, e.date_uncertain,
             (e.private_for_user_id IS NOT NULL) AS private,
             COUNT(a.id)::int AS item_count
      FROM einkauf e
      LEFT JOIN artikel a ON a.einkauf_id = e.id
      LEFT JOIN konto k ON k.id = e.konto_id
      WHERE TRUE
        ${searchFilter(search, receiptSearch(sql`e`))}
        ${storeLike ? sql`AND e.roh_ladenname ILIKE ${storeLike}` : sql``}
        ${kontoId ? sql`AND e.konto_id = ${kontoId}` : sql``}
        ${quellen ? sql`AND e.quelle IN ${sql(quellen)}` : sql``}
        ${onlyHidden ? sql`AND e.private_for_user_id IS NOT NULL` : sql``}
        ${q.from ? sql`AND e.datum >= ${q.from}` : sql``}
        ${q.to ? sql`AND e.datum <= ${q.to}` : sql``}
        ${kontoScope(req.user, sql`e`)}
      GROUP BY e.id, k.name, k.account_type
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
      WHERE quelle IS NOT NULL ${kontoScope(req.user, sql`e`)}
    `;
    return rows.map(r => r.quelle as string);
  });

  /** Flat "Positionen" list: one row per artikel (line item) across all receipts,
   *  joined with its receipt's date/store. Read-only; reuses the receipts search
   *  machinery + kontoScope privacy. Distinct from receipts (Belege) and from the
   *  canonical-product views (Artikel) — those are untouched. */
  app.get('/api/positionen', async (req) => {
    const q = req.query as {
      limit?: string; offset?: string; q?: string; from?: string; to?: string;
      store?: string; branch_id?: string; konto?: string; quelle?: string; kategorie?: string; uncat?: string; nobudget?: string; sort?: string;
    };
    const limit = Math.min(parseInt(q.limit ?? '50', 10) || 50, 200);
    const offset = parseInt(q.offset ?? '0', 10) || 0;
    const search = (q.q ?? '').trim();
    const storeLike = q.store ? `%${q.store}%` : null;
    const branchId = q.branch_id ? parseInt(q.branch_id, 10) : null;
    const kontoId = q.konto ? parseInt(q.konto, 10) : null;
    const quellen = q.quelle ? q.quelle.split(',').filter(Boolean) : null;
    const katLike = q.kategorie ? `%${q.kategorie}%` : null;

    const ORDER: Record<string, Frag> = {
      date_desc: sql`e.datum DESC, e.id DESC, a.sort_order NULLS LAST, a.id`,
      date_asc: sql`e.datum ASC, e.id ASC, a.sort_order NULLS LAST, a.id`,
      price_desc: sql`a.preis DESC NULLS LAST, e.datum DESC`,
      price_asc: sql`a.preis ASC NULLS LAST, e.datum DESC`,
      name_asc: sql`lower(COALESCE(NULLIF(a.canonical_name, ''), a.name)) ASC, e.datum DESC`,
    };
    const orderBy = ORDER[q.sort ?? 'date_desc'] ?? ORDER.date_desc;

    // Same search shape as receiptSearch, but text matches the artikel name +
    // canonical + the receipt's store; supports laden:/kategorie:/preis> too.
    const posSearch = (a: Frag, e: Frag) => ({
      text: [col(sql`${a}.name`), col(sql`${a}.canonical_name`), col(sql`${e}.roh_ladenname`)],
      fields: { laden: col(sql`${e}.roh_ladenname`), kategorie: col(sql`${a}.category_path`) },
      nums: { preis: numCol(sql`${a}.preis`) },
    });

    const rows = await sql`
      SELECT a.id, a.name, a.menge, a.einheit, a.preis, a.canonical_name, a.category_path,
             e.id AS einkauf_id, e.datum, e.roh_ladenname, e.quelle, e.konto_id,
             k.name AS konto_name, (e.private_for_user_id IS NOT NULL) AS private
      FROM artikel a
      JOIN einkauf e ON e.id = a.einkauf_id
      LEFT JOIN konto k ON k.id = e.konto_id
      WHERE TRUE
        ${searchFilter(search, posSearch(sql`a`, sql`e`))}
        ${storeLike ? sql`AND e.roh_ladenname ILIKE ${storeLike}` : sql``}
        ${branchId ? sql`AND e.branch_id = ${branchId}` : sql``}
        ${kontoId ? sql`AND e.konto_id = ${kontoId}` : sql``}
        ${quellen ? sql`AND e.quelle IN ${sql(quellen)}` : sql``}
        ${katLike ? sql`AND a.category_path ILIKE ${katLike}` : sql``}
        ${q.uncat === '1' ? sql`AND (a.category_path IS NULL OR a.category_path = '')` : sql``}
        ${q.nobudget === '1' ? sql`
          AND a.preis IS NOT NULL AND a.category_path IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM fixed_cost_check fc WHERE fc.einkauf_id = e.id OR (fc.bank_tx_id IS NOT NULL AND fc.bank_tx_id = e.bank_tx_id))
          AND NOT EXISTS (
            SELECT 1 FROM budget bu JOIN budget_category bc ON bc.budget_id = bu.id
            WHERE bu.active AND (bu.konto_id IS NULL OR e.konto_id = bu.konto_id)
              AND (a.category_path = bc.category_path OR a.category_path LIKE bc.category_path || '/%')
          )` : sql``}
        ${q.from ? sql`AND e.datum >= ${q.from}` : sql``}
        ${q.to ? sql`AND e.datum <= ${q.to}` : sql``}
        ${kontoScope(req.user, sql`e`)}
      ORDER BY ${orderBy}
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows;
  });

  /** Manually create a purchase (cash or card). Everything is optional so it's
   *  one tap to log something; details can be filled in later. An optional
   *  photo is sent as base64 and stored alongside scanned receipts. */
  app.post('/api/receipts', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as {
      quelle?: string; roh_ladenname?: string; datum?: string;
      gesamt_betrag?: number | string; konto_id?: number | null;
      photo_base64?: string; photo_mime?: string; ocr?: boolean; private?: boolean;
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
    const privateFor = b.private ? (req.user?.id ?? null) : null;

    let bildPfad: string | null = null;
    if (b.photo_base64) {
      const mime = b.photo_mime || 'image/jpeg';
      const ext = mime.includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : 'jpg';
      const data = b.photo_base64.replace(/^data:[^,]+,/, '');
      try {
        const filename = `vds-${crypto.randomUUID()}.${ext}`;
        await writeFile(path.join(RECEIPTS_LOCAL_PATH, filename), Buffer.from(data, 'base64'));
        bildPfad = `/receipts/${filename}`;
      } catch (e) {
        req.log.error(`photo save failed: ${(e as Error).message}`);
      }
    }

    // Attribute the scan to the uploader's household member (Lena / Martin) — the level
    // the receipts filter cares about (not the login user). Null for a user with no
    // linked member. Legacy PWA receipts (pre-column) get it set manually via PATCH.
    const [mem] = req.user?.id ? await sql`SELECT id FROM family_member WHERE user_id = ${req.user.id} ORDER BY sort_order, id LIMIT 1` : [];
    const snappedBy = (mem?.id as number | undefined) ?? null;

    const [row] = await sql`
      INSERT INTO einkauf (datum, roh_ladenname, gesamt_betrag, quelle, konto_id, bild_pfad, private_for_user_id, snapped_by_member_id)
      VALUES (${datum}, ${laden}, ${gesamt}, ${quelle}, ${kontoId}, ${bildPfad}, ${privateFor}, ${snappedBy})
      RETURNING id
    `;

    // If a photo was uploaded, run the same Claude-vision extraction n8n uses,
    // but in the BACKGROUND so the caller gets an instant response (snap a photo
    // on mobile and put the phone away — items fill in a moment later). A failed
    // OCR just leaves the created receipt + photo for manual entry / re-OCR.
    if (bildPfad) {
      await sql`UPDATE einkauf SET ocr_pending = TRUE WHERE id = ${row.id}`;
      void ocrAndStore(row.id as number, bildPfad)
        .catch(e => req.log.error(`background OCR failed for receipt ${row.id}: ${(e as Error).message}`))
        .finally(() => sql`UPDATE einkauf SET ocr_pending = FALSE WHERE id = ${row.id}`.catch(() => {}));
    }
    return { ok: true, id: row.id };
  });

  /** Attach a photo to an EXISTING receipt (e.g. one entered manually without one),
   *  then OCR it in the background — but ONLY when the receipt has no line items yet,
   *  so a manual entry's items are never overwritten. Privacy-guarded. */
  app.post('/api/receipts/:id/photo', { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardReceipt(req, reply, id)) return;
    const b = (req.body ?? {}) as { photo_base64?: string; photo_mime?: string };
    if (!b.photo_base64) return reply.code(400).send({ error: 'photo_base64 required' });
    const mime = b.photo_mime || 'image/jpeg';
    const ext = mime.includes('png') ? 'png' : 'jpg';
    const data = b.photo_base64.replace(/^data:[^,]+,/, '');
    let bildPfad: string;
    try {
      const filename = `vds-${crypto.randomUUID()}.${ext}`;
      await writeFile(path.join(RECEIPTS_LOCAL_PATH, filename), Buffer.from(data, 'base64'));
      bildPfad = `/receipts/${filename}`;
    } catch (e) {
      req.log.error(`photo save failed: ${(e as Error).message}`);
      return reply.code(500).send({ error: 'photo save failed' });
    }
    await sql`UPDATE einkauf SET bild_pfad = ${bildPfad} WHERE id = ${id}`;
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM artikel WHERE einkauf_id = ${id}`;
    if (n === 0) {
      await sql`UPDATE einkauf SET ocr_pending = TRUE WHERE id = ${id}`;
      void ocrAndStore(id, bildPfad)
        .catch(e => req.log.error(`background OCR failed for receipt ${id}: ${(e as Error).message}`))
        .finally(() => sql`UPDATE einkauf SET ocr_pending = FALSE WHERE id = ${id}`.catch(() => {}));
    }
    return { ok: true, bild_pfad: bildPfad, ocr: n === 0 };
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
        ${kontoScope(req.user, sql`e`)}
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
    // Entering/confirming the date clears the "OCR found no date" flag.
    if ('datum' in body && typeof body.datum === 'string') { updates.datum = body.datum; updates.date_uncertain = false; }
    if ('roh_ladenname' in body) updates.roh_ladenname = body.roh_ladenname;
    if ('geprueft' in body) updates.geprueft = Boolean(body.geprueft);
    if ('quelle' in body && typeof body.quelle === 'string') updates.quelle = body.quelle;
    // Mark/unmark this receipt private (visible only to the current user).
    if ('private' in body) updates.private_for_user_id = body.private ? (req.user?.id ?? null) : null;
    // Who scanned/uploaded this receipt (household member). Mainly to set the uploader
    // on legacy PWA receipts that never captured it; null clears the attribution.
    if ('snapped_by_member_id' in body) {
      const v = body.snapped_by_member_id;
      if (v === null || v === '') updates.snapped_by_member_id = null;
      else {
        const n = parseInt(String(v), 10);
        if (!Number.isFinite(n)) return reply.code(400).send({ error: 'invalid snapped_by_member_id' });
        // Only members with a login can scan/upload receipts, so only they can be the snapper.
        const [m] = await sql`SELECT id FROM family_member WHERE id = ${n} AND user_id IS NOT NULL`;
        if (!m) return reply.code(400).send({ error: 'member cannot be a snapper (no user account)' });
        updates.snapped_by_member_id = n;
      }
    }
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
    // On accept (geprueft → true) with no total entered, fall back to the sum of the
    // line items — so a cash receipt entered without a total still shows a sum in the
    // overview (and counts in store totals). Only fills a missing total; never
    // overwrites one the user/OCR already set.
    if (updates.geprueft === true && !('gesamt_betrag' in body)) {
      const [cur] = await sql`SELECT gesamt_betrag FROM einkauf WHERE id = ${id}`;
      if (cur && cur.gesamt_betrag === null) {
        const [{ sum }] = await sql`SELECT COALESCE(SUM(preis), 0)::numeric(10,2) AS sum FROM artikel WHERE einkauf_id = ${id}`;
        if (Number(sum) > 0) updates.gesamt_betrag = Number(sum);
      }
    }
    // Finalise gate: a receipt whose date OCR couldn't read must get a date first.
    if (updates.geprueft === true && updates.date_uncertain !== false) {
      const [cur] = await sql`SELECT date_uncertain FROM einkauf WHERE id = ${id}`;
      if (cur?.date_uncertain) return reply.code(400).send({ error: 'date_required', message: 'Bitte zuerst das Datum eingeben.' });
    }
    // Finalise gate: a receipt paid from an account WITH bank statements (Giro / Kredit-
    // karte) needs a linked bank booking to be complete — the proof the money left the
    // account. But only when statements are actually IMPORTED for that account: a house-
    // hold that never imports bank CSVs, or a cash / crypto / securities / PayPal account,
    // finalises without one (nothing to reconcile against). Both link directions count.
    if (updates.geprueft === true) {
      // The account being SET in this same PATCH wins over the stored one (avoid gating
      // on a stale account when konto_id + geprueft change together).
      const kId = ('konto_id' in updates)
        ? (updates.konto_id as number | null)
        : (((await sql`SELECT konto_id FROM einkauf WHERE id = ${id}`)[0]?.konto_id ?? null) as number | null);
      if (kId != null) {
        const [k] = await sql`
          SELECT account_type, EXISTS(SELECT 1 FROM bank_tx WHERE konto_id = ${kId}) AS imported
          FROM konto WHERE id = ${kId}`;
        if (k && accountHasStatements(k.account_type as string | null) && k.imported === true) {
          const [e] = await sql`
            SELECT bank_tx_id, EXISTS(SELECT 1 FROM bank_tx bt WHERE bt.einkauf_id = ${id}) AS has_sibling
            FROM einkauf WHERE id = ${id}`;
          const hasBank = e && (e.bank_tx_id != null || e.has_sibling === true);
          if (!hasBank) return reply.code(400).send({ error: 'bank_required', message: 'Bitte zuerst einen Bankauszug verknüpfen (Girokonto/Kreditkarte).' });
        }
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

    // Optional user hint fed into the OCR prompt ("you're missing the VAT", "amounts are
    // gross not net", …) so a re-run can fix what the first pass got wrong.
    const hint = ((req.body ?? {}) as { hint?: string }).hint?.toString().trim() || null;
    try {
      const { items, confidence } = await ocrAndStore(id, bildPfad, hint);
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
    if (!await guardReceipt(req, reply, id)) return; // another user's private receipt → 404/403
    // datum is a DATE column; coerce to YYYY-MM-DD string so the comparison
    // is not affected by timezone juggling that breaks row-tuple compares.
    const [cur] = await sql`SELECT TO_CHAR(datum, 'YYYY-MM-DD') AS datum, id FROM einkauf WHERE id = ${id}`;
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const datum = cur.datum as string;
    const curId = cur.id as number;

    // Respect the same filters the list used, so prev/next stay within the
    // visible (filtered) set the user is navigating.
    const fq = req.query as { q?: string; store?: string; konto?: string; quelle?: string; from?: string; to?: string };
    const search = (fq.q ?? '').trim();
    const storeLike = fq.store ? `%${fq.store}%` : null;
    const kontoId = fq.konto ? parseInt(fq.konto, 10) : null;
    const quellen = fq.quelle ? fq.quelle.split(',').filter(Boolean) : null;
    const filter = sql`
      ${searchFilter(search, receiptSearch(sql`einkauf`))}
      ${storeLike ? sql`AND einkauf.roh_ladenname ILIKE ${storeLike}` : sql``}
      ${kontoId ? sql`AND einkauf.konto_id = ${kontoId}` : sql``}
      ${quellen ? sql`AND einkauf.quelle IN ${sql(quellen)}` : sql``}
      ${fq.from ? sql`AND einkauf.datum >= ${fq.from}` : sql``}
      ${fq.to ? sql`AND einkauf.datum <= ${fq.to}` : sql``}
      ${kontoScope(req.user, sql`einkauf`)}
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
             e.konto_id, e.quelle, k.name AS konto_name, k.account_type, e.ocr_pending, e.date_uncertain,
             -- a bank link is REQUIRED for completeness only when this account both has
             -- statements (Giro/Kreditkarte) and actually has some imported (else nothing to link).
             (k.account_type IN ('giro', 'kreditkarte') AND EXISTS(SELECT 1 FROM bank_tx bx WHERE bx.konto_id = e.konto_id)) AS bank_expected,
             e.private_for_user_id, e.bank_tx_id, e.snapped_by_member_id,
             bt.booking_date::text AS bank_booking, bt.amount::float8 AS bank_amount, bt.counterparty AS bank_counterparty,
             (e.private_for_user_id IS NOT NULL) AS private,
             EXISTS(SELECT 1 FROM email_message em WHERE em.einkauf_id = e.id) AS has_email
      FROM einkauf e LEFT JOIN konto k ON k.id = e.konto_id
      LEFT JOIN bank_tx bt ON bt.id = e.bank_tx_id
      WHERE e.id = ${id}
    `;
    if (!receipts.length) return reply.code(404).send({ error: 'not found' });
    // Per-receipt privacy: another user's private receipt is forbidden — unless the
    // caller is a super-admin (sees_all_konten = "kann alles sehen", no exception).
    const pf = receipts[0].private_for_user_id as number | null;
    if (pf !== null && pf !== (req.user?.id ?? null) && !req.user?.sees_all_konten) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const artikel = await sql`
      SELECT a.id, a.name, a.menge, a.einheit, a.preis, a.original_text,
             a.ai_guess, a.canonical_name, a.category_path, a.user_corrected
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

    const r0 = receipts[0];
    // ALL bank bookings this receipt is matched to — the primary (einkauf.bank_tx_id)
    // AND split siblings (bank_tx.einkauf_id = this receipt, e.g. an Amazon order paid
    // per shipment). Both link directions; ordered by date.
    const bankRows = await sql`
      SELECT bt.id, bt.booking_date::text AS booking_date, bt.amount::float8 AS amount, bt.counterparty
      FROM bank_tx bt
      WHERE bt.einkauf_id = ${id} OR bt.id = ${(r0.bank_tx_id as number | null) ?? -1}
      ORDER BY bt.booking_date, bt.id`;
    const banks = bankRows.map(b => ({ id: b.id as number, booking_date: b.booking_date as string, amount: b.amount as number, counterparty: b.counterparty as string | null }));
    return {
      ...r0,
      // All matched bank bookings; `bank` stays the primary for existing callers.
      banks,
      bank: banks.find(b => b.id === r0.bank_tx_id) ?? banks[0] ?? null,
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

  /** Candidate bank bookings to attach to THIS receipt, for the receipt-side "Bankauszug
   *  finden" picker (completeness on Giro/Kreditkarte accounts). Searches OPEN debits across
   *  ALL accounts — an invoice can be paid from a different account than it's filed under
   *  (e.g. a household bill arriving in a personal mailbox), so discovering the paying account
   *  is the point; linking then moves the invoice onto the matched statement's account. Each
   *  candidate carries its konto so the UI can flag/confirm an account move. Amount-closest
   *  first; optional free text. Link via POST /api/finances/bank/:id/link. */
  app.get('/api/receipts/:id/bank-candidates', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardReceipt(req, reply, id)) return;
    const [e] = await sql`SELECT konto_id, gesamt_betrag::float8 AS betrag, datum::text AS datum FROM einkauf WHERE id = ${id}`;
    if (!e) return reply.code(404).send({ error: 'not found' });
    const q = String((req.query as { q?: string }).q ?? '').trim();
    const like = `%${q}%`;
    const amtQ = q.replace(/\./g, '').replace(',', '.');
    const amtNum = /^\d+(\.\d+)?$/.test(amtQ) ? parseFloat(amtQ) : null;
    const target = e.betrag != null ? Math.abs(e.betrag as number) : null;
    const results = await sql`
      SELECT bt.id, bt.booking_date::text AS datum, bt.amount::float8 AS amount, bt.counterparty, bt.description,
             bt.konto_id, (SELECT name FROM konto WHERE id = bt.konto_id) AS konto_name
      FROM bank_tx bt
      WHERE bt.amount < 0 AND bt.einkauf_id IS NULL
        -- also exclude bookings that are already a receipt's PRIMARY link (einkauf.bank_tx_id
        -- set but bank_tx.einkauf_id still NULL — e.g. generated/auto-matched receipts),
        -- else linking one here would silently steal it from that receipt.
        AND NOT EXISTS (SELECT 1 FROM einkauf e2 WHERE e2.bank_tx_id = bt.id)
        ${q ? sql`AND (bt.counterparty ILIKE ${like} OR bt.description ILIKE ${like}
                       ${amtNum != null ? sql`OR ABS(ABS(bt.amount) - ${amtNum}) <= 0.01` : sql``}
                       OR bt.booking_date::text ILIKE ${like})` : sql``}
      -- same account first (the common case), then amount-closest, then newest.
      ORDER BY (bt.konto_id IS DISTINCT FROM ${e.konto_id ?? null}), ABS(ABS(bt.amount) - COALESCE(${target}::float8, ABS(bt.amount))) ASC, bt.booking_date DESC
      LIMIT 30`;
    return { results, receipt: { betrag: e.betrag, datum: e.datum, konto_id: e.konto_id } };
  });

  /** The source e-mail behind an e-mail-imported receipt (privacy-guarded). HTML
   *  is lightly scrubbed; the client renders it in a sandboxed iframe. */
  app.get('/api/receipts/:id/email', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    if (!await guardReceipt(req, reply, id)) return;
    const [em] = await sql`SELECT from_addr, subject, sent_at, html, body_text FROM email_message WHERE einkauf_id = ${id}`;
    if (!em) return reply.code(404).send({ error: 'no email' });
    return {
      from: em.from_addr,
      subject: em.subject,
      sent_at: em.sent_at,
      html: em.html ? sanitizeEmailHtml(em.html as string) : null,
      text: em.body_text,
    };
  });
}
