/**
 * refundReconcile — the ONE atomic way to book a refund against a receipt, shared by all
 * three entry points (bank-credit assignment, mail-log confirm, manual "Erstattung erfassen").
 *
 * Two shapes:
 *   • discount_only  → a single negative "Rabatt" position (canonical_name NULL, no refund_for).
 *     Nets spend + the receipt's derived net; touches NO product's quantity.
 *   • item return    → for each returned line {artikel_id, return_qty}: if the whole line is
 *     returned, add a full-refund negative position against it; if only SOME units of a combined
 *     line are returned (2× Ventilator, return 1), SPLIT the line into a kept part + a returned
 *     part first, then full-refund the returned part. The kept part stays a normal position, so
 *     Warenstamm still counts exactly the kept quantity — reusing the tested all-or-nothing
 *     excludeRefunded() with ZERO change to the product-stat layer.
 *
 * Invariants (why this is safe):
 *   • einkauf.gesamt_betrag (gross paid) is NEVER touched — it stays the bank-reconciliation anchor.
 *   • A split preserves the line's gross: keepPreis + retPreis == original preis (penny-exact), so
 *     itemSum(non-refund) still equals the gross and no "Summe ≠ Bon" banner fires.
 *   • Spend nets automatically because every spend surface sums artikel.preis and a refund is a
 *     negative position (v_transactions signs -preis).
 *   • Over-refund guard: the receipt's derived net can never be pushed below 0.
 *   • Idempotent when ledger- or bank-originated (single-winner ledger claim + einkauf_id-IS-NULL
 *     bank-credit consume), so a double-click or race can't double-book.
 */
import type { TransactionSql } from 'postgres';
import sql from '../db.js';
import { getConfig } from '../config.js';

export class RefundError extends Error {
  constructor(public code: RefundErrorCode, message: string) {
    super(message);
    this.name = 'RefundError';
  }
}
export type RefundErrorCode =
  | 'not_found' | 'forbidden' | 'invalid' | 'cap' | 'already' | 'overrefund' | 'bank_taken';

export interface RefundReturnLine {
  artikel_id: number;
  return_qty: number; // units returned; 0 < return_qty <= the position's menge
}
export interface RefundEmailAttach {
  imported_email_id?: number | null;
  from_addr?: string | null;
  subject?: string | null;
  sent_at?: string | null; // ISO
  html?: string | null;
  body_text?: string | null;
  pdf_pfad?: string | null;
}
export interface RefundReconcileInput {
  einkauf_id: number;
  user_id: number; // caller — for receipt visibility + ledger claim scoping
  discount_only: boolean;
  amount: number; // total refund € (>0). Authoritative for discount_only; item-return books the sum of returned portions.
  description?: string | null;
  lines?: RefundReturnLine[]; // required (non-empty) when !discount_only
  bank_tx_id?: number | null; // consume this bank credit (sets bank_tx.einkauf_id)
  ledger_id?: number | null; // imported_email ledger id (mail-originated) → single-winner claim + resolve
  refund_email?: RefundEmailAttach | null;
}
export interface RefundReconcileResult {
  einkauf_id: number;
  refund_artikel_ids: number[];
  total: number; // positive € actually refunded
}

const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/** Renumber a receipt's positions to multiples of 10, return afterId's slot + 5 (gap insert). */
async function gapAfter(tx: TransactionSql, einkaufId: number, afterId: number): Promise<number> {
  await tx`
    WITH ordered AS (
      SELECT id, (ROW_NUMBER() OVER (ORDER BY COALESCE(sort_order, id), id)) * 10 AS rn
      FROM artikel WHERE einkauf_id = ${einkaufId}
    )
    UPDATE artikel a SET sort_order = o.rn FROM ordered o WHERE a.id = o.id`;
  const [pos] = await tx`SELECT sort_order FROM artikel WHERE id = ${afterId}`;
  return ((pos?.sort_order as number | null) ?? 0) + 5;
}

/** The receipt's dominant non-Meta category — so a discount-only refund nets the right bucket. */
async function dominantCategory(tx: TransactionSql, einkaufId: number): Promise<string | null> {
  const [dom] = await tx`
    SELECT category_path FROM artikel
    WHERE einkauf_id = ${einkaufId} AND category_path IS NOT NULL
      AND category_path NOT LIKE 'Meta/%' AND NOT is_refund
    GROUP BY category_path ORDER BY SUM(preis) DESC LIMIT 1`;
  return (dom?.category_path as string | null) ?? null;
}

/**
 * Book a reconciled refund. Throws RefundError on any validation/idempotency failure (the tx rolls
 * back, nothing partial persists). Everything runs in ONE transaction.
 */
export async function bookRefundReconciliation(input: RefundReconcileInput): Promise<RefundReconcileResult> {
  const einkaufId = Number(input.einkauf_id);
  if (!Number.isInteger(einkaufId)) throw new RefundError('invalid', 'Kein Beleg gewählt.');
  const cap = Number(await getConfig('income.max_mail_amount'));
  const descBase = (String(input.description ?? '').trim() || 'Erstattung').slice(0, 200);

  // Receipt must be visible to this user (shared, own-private, or super-admin).
  const [u] = await sql`SELECT sees_all_konten FROM users WHERE id = ${input.user_id}`;
  const seesAll = u?.sees_all_konten === true;
  const [tgt] = await sql`
    SELECT e.id, e.gesamt_betrag::float8 AS gesamt_betrag FROM einkauf e WHERE e.id = ${einkaufId}
      ${seesAll ? sql`` : sql`AND (e.private_for_user_id IS NULL OR e.private_for_user_id = ${input.user_id})`}`;
  if (!tgt) throw new RefundError('not_found', 'Beleg nicht gefunden oder nicht sichtbar.');

  try {
    return await sql.begin(async (tx) => {
      // 1) Idempotency: claim the mail ledger row (single winner). A second commit finds it
      //    already 'processing'/resolved → no row → abort.
      if (input.ledger_id != null) {
        const claim = await tx`
          UPDATE imported_email SET status = 'processing', claimed_at = NOW()
          WHERE id = ${input.ledger_id} AND user_id = ${input.user_id}
            AND einkauf_id IS NULL AND income_id IS NULL
            AND status IN ('skipped', 'failed', 'refund_suggested')
          RETURNING id`;
        if (!claim.length) throw new RefundError('already', 'Bereits verbucht oder in Bearbeitung.');
      }

      // Serialize refunds on THIS receipt: lock it so a concurrent refund from another source
      // (manual + bank racing) can't slip past the over-refund guard by not yet seeing our
      // uncommitted refund rows (READ COMMITTED TOCTOU). The second tx blocks here until we commit.
      await tx`SELECT 1 FROM einkauf WHERE id = ${einkaufId} FOR UPDATE`;

      const refundIds: number[] = [];
      let total = 0;

      if (input.discount_only) {
        // Pure price reduction — no item returned. One negative line, canonical NULL → invisible to
        // product stats, nets spend. Amount is authoritative here.
        const amount = round2(Number(input.amount));
        if (!Number.isFinite(amount) || amount <= 0) throw new RefundError('invalid', 'Betrag muss größer als 0 sein.');
        if (amount > cap) throw new RefundError('cap', `Betrag über dem Limit (max. ${cap} €).`);
        const category = await dominantCategory(tx, einkaufId);
        const sort = await gapAfter(tx, einkaufId, await lastPositionId(tx, einkaufId));
        const [row] = await tx`
          INSERT INTO artikel (einkauf_id, name, menge, einheit, preis, category_path, original_text, canonical_name, is_refund, refund_for_artikel_id, sort_order)
          VALUES (${einkaufId}, ${descBase || 'Rabatt'}, 1, NULL, ${-amount}, ${category}, ${'Rabatt/Erstattung: ' + descBase}, NULL, TRUE, NULL, ${sort})
          RETURNING id`;
        refundIds.push(row.id as number);
        total = amount;
      } else {
        // Item return. Book each returned line as a full refund of the returned portion, splitting a
        // combined line first when only some units come back.
        const lines = input.lines ?? [];
        if (!lines.length) throw new RefundError('invalid', 'Keine zurückgegebene Position gewählt.');
        const seen = new Set<number>();
        for (const line of lines) {
          const artId = Number(line.artikel_id);
          const qty = Number(line.return_qty);
          if (!Number.isInteger(artId) || seen.has(artId)) throw new RefundError('invalid', 'Ungültige Position.');
          seen.add(artId);
          // Lock the original position; it must belong to this receipt, not be a refund itself,
          // and NOT already be the target of a refund (else a repeat/double-submit would book a
          // second refund against an already-returned line — silently over-netting spend and, for
          // a full return, dropping the kept line from product stats). A legitimate repeat partial
          // return targets the split-off KEPT part, which has no refund pointing at it, so it stays
          // allowed.
          const [p] = await tx`
            SELECT id, menge::float8 AS menge, preis::float8 AS preis, canonical_name, category_path, einheit, name, ai_guess, original_text
            FROM artikel a WHERE a.id = ${artId} AND a.einkauf_id = ${einkaufId} AND NOT a.is_refund
              AND NOT EXISTS (SELECT 1 FROM artikel r WHERE r.refund_for_artikel_id = a.id) FOR UPDATE`;
          if (!p) throw new RefundError('invalid', 'Position gehört nicht zu diesem Beleg oder ist bereits erstattet.');
          const menge = (p.menge as number | null) ?? 1;
          const preis = (p.preis as number | null) ?? 0;
          if (!(qty > 0) || qty > menge + 1e-9) throw new RefundError('invalid', 'Ungültige Rückgabemenge.');
          const partial = qty < menge - 1e-9;
          if (partial && (!Number.isInteger(menge) || !Number.isInteger(qty))) {
            // Non-integer (mass/volume) lines can't be unit-split — return the whole line or use "nur Rabatt".
            throw new RefundError('invalid', 'Teilmenge nur bei ganzzahliger Stückzahl möglich.');
          }

          let targetId = artId;
          let retPreis = round2(preis);
          if (partial) {
            const keepMenge = menge - qty;
            const keepPreis = round2((preis * keepMenge) / menge);
            retPreis = round2(preis - keepPreis); // exact remainder → keep + ret == original preis
            // The original row BECOMES the kept part (keeps its canonical/category/aliases).
            await tx`UPDATE artikel SET menge = ${keepMenge}, preis = ${keepPreis} WHERE id = ${artId}`;
            // The returned part is its own positive position, sitting right after the kept one.
            const retSort = await gapAfter(tx, einkaufId, artId);
            const [ret] = await tx`
              INSERT INTO artikel (einkauf_id, name, canonical_name, category_path, menge, einheit, preis, ai_guess, original_text, sort_order, is_refund)
              VALUES (${einkaufId}, ${p.name}, ${p.canonical_name}, ${p.category_path}, ${qty}, ${p.einheit}, ${retPreis}, ${p.ai_guess}, ${p.original_text}, ${retSort}, FALSE)
              RETURNING id`;
            targetId = ret.id as number;
          }
          // The negative refund line against the (whole) returned position.
          const cSort = await gapAfter(tx, einkaufId, targetId);
          const [c] = await tx`
            INSERT INTO artikel (einkauf_id, name, menge, einheit, preis, category_path, original_text, canonical_name, is_refund, refund_for_artikel_id, sort_order)
            VALUES (${einkaufId}, ${'Rückgabe: ' + (p.name as string | null ?? descBase)}, ${qty}, NULL, ${-retPreis}, ${p.category_path},
                    ${'Erstattung/Rückgabe: ' + descBase}, NULL, TRUE, ${targetId}, ${cSort})
            RETURNING id`;
          refundIds.push(c.id as number);
          total = round2(total + retPreis);
        }
        if (total > cap) throw new RefundError('cap', `Erstattung über dem Limit (max. ${cap} €).`);
      }

      // 2) Over-refund guard: the derived net (gross + Σ ALL refund positions, new ones included —
      //    they are already inserted in this tx) can't go below 0.
      const base = (tgt.gesamt_betrag as number | null) ??
        Number((await tx`SELECT COALESCE(SUM(preis),0)::float8 AS s FROM artikel WHERE einkauf_id = ${einkaufId} AND NOT is_refund`)[0].s);
      const [{ allref }] = await tx`
        SELECT COALESCE(SUM(preis),0)::float8 AS allref FROM artikel WHERE einkauf_id = ${einkaufId} AND is_refund`;
      const netAfter = round2(base + Number(allref));
      if (netAfter < -0.01) throw new RefundError('overrefund', 'Erstattung übersteigt den Belegbetrag.');

      // 3) Consume the bank credit (idempotent: only if still unlinked).
      if (input.bank_tx_id != null) {
        const linked = await tx`
          UPDATE bank_tx SET einkauf_id = ${einkaufId}
          WHERE id = ${Number(input.bank_tx_id)} AND einkauf_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM income i WHERE i.bank_tx_id = bank_tx.id)
            AND NOT EXISTS (SELECT 1 FROM fixed_cost_check fc WHERE fc.bank_tx_id = bank_tx.id)
          RETURNING id`;
        if (!linked.length) throw new RefundError('bank_taken', 'Bankbuchung ist bereits zugeordnet.');
      }

      // 4) Attach the refund mail (update a staged row from detect-time, else insert).
      if (input.refund_email) {
        const m = input.refund_email;
        const primary = refundIds[0] ?? null;
        const upd = m.imported_email_id != null
          ? await tx`UPDATE refund_email SET einkauf_id = ${einkaufId}, refund_artikel_id = ${primary}
                     WHERE imported_email_id = ${m.imported_email_id} AND einkauf_id IS NULL RETURNING id`
          : [];
        if (!upd.length) {
          await tx`
            INSERT INTO refund_email (imported_email_id, einkauf_id, refund_artikel_id, from_addr, subject, sent_at, html, body_text, pdf_pfad)
            VALUES (${m.imported_email_id ?? null}, ${einkaufId}, ${primary}, ${m.from_addr ?? null}, ${m.subject ?? null},
                    ${m.sent_at ?? null}, ${m.html ?? null}, ${m.body_text ?? null}, ${m.pdf_pfad ?? null})`;
        }
      }

      // 5) Resolve the mail ledger row.
      if (input.ledger_id != null) {
        await tx`UPDATE imported_email SET einkauf_id = ${einkaufId}, status = 'refund',
                 reason = ${'Erstattung: -' + total.toFixed(2) + ' € auf Beleg #' + einkaufId} WHERE id = ${input.ledger_id}`;
      }

      return { einkauf_id: einkaufId, refund_artikel_ids: refundIds, total };
    });
  } catch (e) {
    if (e instanceof RefundError) throw e;
    throw new RefundError('invalid', (e as Error).message.slice(0, 300));
  }
}

/** Last position id of a receipt (for gap-appending a discount line at the end). */
async function lastPositionId(tx: TransactionSql, einkaufId: number): Promise<number> {
  const [row] = await tx`SELECT id FROM artikel WHERE einkauf_id = ${einkaufId} ORDER BY COALESCE(sort_order, id) DESC, id DESC LIMIT 1`;
  return (row?.id as number | null) ?? 0;
}

export interface RefundCandidate {
  id: number; datum: string; roh_ladenname: string | null; gesamt_betrag: number | null; konto_name: string | null;
  positions: { id: number; name: string; preis: number | null; menge: number | null; einheit: string | null }[];
}

/** Find the ORIGINAL receipts a refund most likely belongs to, the way a human would, in priority
 *  order: (1) order/reference number (strongest, generic across vendors — matched against the
 *  receipt's stored source mail and any position's raw text); (2) the refunded ITEM as a position
 *  in a receipt from the SAME vendor; (3) the item in any receipt; (4) same vendor; (5) amount
 *  (last-resort fallback, NOT a price corridor). Per receipt, the position matching the refunded
 *  item is surfaced first so the dialog can pre-select it. User-visibility scoped. Shared by the
 *  mail reinterpret, the mail-log refund preview, and the bank-credit refund flow. */
export async function findRefundCandidates(
  userId: number,
  m: { amount: number; merchant: string; item: string; order_ref: string; datum: string | null },
): Promise<RefundCandidate[]> {
  const [u] = await sql`SELECT sees_all_konten FROM users WHERE id = ${userId}`;
  const visScope = u?.sees_all_konten ? sql`` : sql`AND (e.private_for_user_id IS NULL OR e.private_for_user_id = ${userId})`;
  const merchant = (m.merchant ?? '').trim();
  const like = merchant ? '%' + merchant + '%' : null;
  const itemLike = (m.item ?? '').trim() ? '%' + m.item.trim() + '%' : null;
  const ref = (m.order_ref ?? '').trim() || null;
  const amtPos = m.amount > 0;
  const refDate = m.datum;
  const F = sql`FALSE`;
  // All ${m.amount} cast ::numeric (postgres.js int4-inference guard).
  const refMatch = ref
    ? sql`(EXISTS(SELECT 1 FROM email_message em WHERE em.einkauf_id = e.id AND (em.body_text ILIKE ${'%' + ref + '%'} OR em.subject ILIKE ${'%' + ref + '%'}))
           OR EXISTS(SELECT 1 FROM artikel ar WHERE ar.einkauf_id = e.id AND ar.original_text ILIKE ${'%' + ref + '%'}))` : F;
  const itemMatch = itemLike
    ? sql`EXISTS(SELECT 1 FROM artikel ai WHERE ai.einkauf_id = e.id AND NOT ai.is_refund AND (ai.name ILIKE ${itemLike} OR ai.canonical_name ILIKE ${itemLike} OR ai.ai_guess ILIKE ${itemLike} OR ai.original_text ILIKE ${itemLike}))` : F;
  // Bidirectional vendor match: the mail flow passes a SHORT merchant ("Amazon") so the receipt
  // name CONTAINS it; the bank flow passes the LONG bank counterparty ("AMAZON PAYMENTS EUROPE …")
  // which CONTAINS the receipt's (short) name. Guard the reverse on length ≥ 3 so a 1–2 char store
  // name can't match everything.
  const vendorMatch = like
    ? sql`(e.roh_ladenname ILIKE ${like} OR (LENGTH(COALESCE(e.roh_ladenname,'')) >= 3 AND ${merchant} ILIKE '%' || e.roh_ladenname || '%'))` : F;
  // Amount matches the receipt TOTAL (full refund) OR a single non-refund POSITION (a PARTIAL
  // refund — an 89,99 credit against a 179,98 receipt that has an 89,99 line).
  const amountNear = amtPos
    ? sql`(ABS(COALESCE(e.gesamt_betrag,0) - ${m.amount}::numeric) <= GREATEST(1, ${m.amount}::numeric * 0.01)
           OR EXISTS(SELECT 1 FROM artikel ap WHERE ap.einkauf_id = e.id AND NOT ap.is_refund
                     AND ABS(COALESCE(ap.preis,0) - ${m.amount}::numeric) <= GREATEST(0.5, ${m.amount}::numeric * 0.02)))` : F;
  const anySignal = !!(ref || itemLike || like || amtPos);
  // ORDER BY from PRESENT signals only (a missing signal is the bare constant FALSE, which Postgres
  // rejects in ORDER BY). Innermost tie-breaker first, then prepend by priority.
  let ord = sql`e.datum DESC`;
  if (amtPos) ord = sql`(${amountNear}) DESC, ${ord}`;
  if (like) ord = sql`(${vendorMatch}) DESC, ${ord}`;
  if (itemLike) ord = sql`(${itemMatch}) DESC, ${ord}`;
  if (itemLike && like) ord = sql`((${itemMatch}) AND (${vendorMatch})) DESC, ${ord}`;
  if (ref) ord = sql`(${refMatch}) DESC, ${ord}`;
  const cands = await sql`
    SELECT e.id, e.datum::text AS datum, e.roh_ladenname, e.gesamt_betrag::float8 AS gesamt_betrag, k.name AS konto_name
    FROM einkauf e
    LEFT JOIN konto k ON k.id = e.konto_id
    WHERE TRUE
      ${anySignal ? sql`AND ((${refMatch}) OR (${itemMatch}) OR (${vendorMatch}) OR (${amountNear}))` : sql``}
      ${refDate ? sql`AND e.datum <= ${refDate}::date` : sql``}
      ${visScope}
    ORDER BY ${ord}
    LIMIT 8`;
  const posItemMatch = itemLike
    ? sql`(name ILIKE ${itemLike} OR canonical_name ILIKE ${itemLike} OR ai_guess ILIKE ${itemLike} OR original_text ILIKE ${itemLike})` : F;
  const candidates: RefundCandidate[] = [];
  for (const c of cands) {
    const pos = await sql`
      SELECT id, COALESCE(NULLIF(canonical_name,''), NULLIF(ai_guess,''), name, '?') AS name,
             preis::float8 AS preis, menge::float8 AS menge, einheit
      FROM artikel WHERE einkauf_id = ${c.id as number} AND NOT is_refund
      ORDER BY ${itemLike ? sql`(${posItemMatch}) DESC,` : sql``} ABS(COALESCE(preis,0) - ${m.amount}::numeric) ASC, id ASC`;
    candidates.push({
      id: c.id as number, datum: c.datum as string, roh_ladenname: c.roh_ladenname as string | null,
      gesamt_betrag: (c.gesamt_betrag as number | null) ?? null, konto_name: c.konto_name as string | null,
      positions: pos.map(p => ({
        id: p.id as number, name: p.name as string, preis: (p.preis as number | null) ?? null,
        menge: (p.menge as number | null) ?? null, einheit: (p.einheit as string | null) ?? null,
      })),
    });
  }
  return candidates;
}
