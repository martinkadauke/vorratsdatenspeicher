/**
 * returnSlip — a scanned parcel drop-off slip CLOSES the returns it belongs to.
 *
 * Martin's rule (2026-11-10): "Die Rückgabe muss automatisch als abgeschlossen gelten, wenn ich den
 * Zettel eingescannt habe … der Beleg soll auf 0 kommen" — so unlike every other refund path in VDS,
 * which only SUGGESTS, a recognised slip BOOKS: the returned position of the original Amazon receipt
 * gets its full-refund counter-position (it nets to 0; the rest of the receipt stays as bought).
 *
 * The slip itself names neither order nor item — only a tracking number, which Amazon's mails never
 * repeat. Pairing therefore works on the open Amazon returns VDS already knows from the mails:
 *   • as many open returns as slips (or fewer)  → all of them, no question asked;
 *   • more open returns than slips               → the ones Amazon already confirmed as dropped off
 *                                                  ("Abgabebestätigung"), if that makes it exact;
 *   • still ambiguous                             → nothing is booked; the slip lists the candidates
 *                                                  and the user picks (POST /api/receipts/:id/retoure).
 *
 * "Komplett abgeschlossen" comes later and is not this module's job: the bank credit in the CSV, or
 * for Amazon store credit the refund mail (refund_email.confirmed_at / confirmed_by).
 */
import sql, { adminSql } from '../db.js';
import type { ReturnSlipResult } from '../llm/ocr.js';
import { detectReturnAnnouncement, isStoreCreditRefund, sameReturnItem } from './refundHeuristic.js';
import { bookRefundReconciliation, findRefundCandidates, RefundError } from './refundReconcile.js';

/** An Amazon return VDS knows from the mails and that no slip has closed yet. */
export interface OpenReturn {
  ledgerId: number;        // imported_email.id — the refund suggestion (or booking) for this return
  userId: number;          // mailbox owner: the booking runs with their receipt visibility
  status: string;          // 'refund_suggested' (not yet booked) | 'refund' (booked by hand already)
  item: string | null;
  amount: number | null;
  orderRef: string | null;
  merchant: string | null;
  sentAt: string | null;
  droppedOffAt: string | null;   // Amazon's drop-off confirmation, if it came
}

/** What a slip did — kept on the slip's receipt (einkauf.retoure_info) so the screen can say it. */
export interface RetoureInfo {
  slips: ReturnSlipResult['slips'];
  closed: { ledgerId: number; item: string | null; amount: number | null; einkaufId: number | null; note: string | null }[];
  /** Set only while the pairing is ambiguous: the returns to choose from and how many slips remain. */
  pending: { ledgerId: number; item: string | null; amount: number | null; orderRef: string | null }[] | null;
  pendingCount: number;
  note: string | null;
  /** Other slip receipts of the same drop-off that closed returns together with this one. */
  partners?: number[];
}

const RETURN_FROM = /rueckgabe@amazon\.|return@amazon\./i;
const DAY_MS = 86_400_000;
/** pg advisory lock serialising slip handling across Swarm replicas (mail 825041, drop folder 825042). */
const SLIP_LOCK = 825043;

/** Two slips photographed one after the other are OCR'd in parallel; each must see the other's
 *  outcome, or both stay undecided. The lock lives on an owner-lane connection: in the demo the
 *  request's household connection cannot reserve another, and advisory locks are database-wide. */
async function withSlipLock<T>(fn: () => Promise<T>): Promise<T> {
  const conn = await adminSql.reserve();
  try {
    await conn`SELECT pg_advisory_lock(${SLIP_LOCK})`;
    try {
      return await fn();
    } finally {
      await conn`SELECT pg_advisory_unlock(${SLIP_LOCK})`;
    }
  } finally {
    conn.release();
  }
}

const chooseNote = (returns: number, slips: number) =>
  `${returns} offene Amazon-Rücksendungen, ${slips} Zettel — bitte wählen, welche abgegeben wurde`;
/** Amazon's return windows are 14–30 days; an announcement older than this is not what a slip
 *  handed in today belongs to (it was dropped off long ago, or never). */
const ANNOUNCE_MAX_AGE_DAYS = 35;
/** A refund mail belongs to a slip only around the drop-off: Amazon sometimes refunds within the
 *  hour, before the slip is even scanned. A refund from weeks ago closed a long-past drop-off — on
 *  dev the SanDisk refund of 10.09., still unconfirmed in the import log, made two slips of 10.11.
 *  look ambiguous against three "open" returns. */
const REFUND_AROUND_DAYS = 3;

/** Open Amazon returns a slip handed in at `slipAt` can belong to, oldest first. A return counts once
 *  a mail announced it or Amazon's returns desk refunded it — a price-guarantee credit is NOT a
 *  return and never matches. `slipAt` null (the user picking by hand) drops the time windows. */
export async function loadOpenReturns(userIds: number[] | null, slipAt: string | null): Promise<OpenReturn[]> {
  const rows = await sql`
    SELECT i.id AS ledger_id, i.user_id, i.status, re.item, re.amount::float8 AS amount, re.order_ref,
           re.merchant, re.from_addr, re.subject, re.body_text, re.sent_at::text AS sent_at,
           re.dropoff_at::text AS dropoff_at
    FROM refund_email re JOIN imported_email i ON i.id = re.imported_email_id
    WHERE i.status IN ('refund_suggested', 'refund')
      AND re.dropoff_einkauf_id IS NULL
      AND (re.merchant ILIKE '%amazon%' OR re.from_addr ILIKE '%amazon%')
      ${userIds ? sql`AND i.user_id = ANY(${userIds})` : sql``}
    ORDER BY re.sent_at NULLS LAST, i.id`;
  const at = slipAt ? Date.parse(slipAt) : NaN;
  return rows
    .filter(r => {
      const announced = detectReturnAnnouncement(r.subject as string | null, r.body_text as string | null).isAnnouncement;
      if (!announced && !RETURN_FROM.test(String(r.from_addr ?? ''))) return false;
      if (!Number.isFinite(at)) return true;
      const sent = r.sent_at ? Date.parse(String(r.sent_at)) : NaN;
      if (!Number.isFinite(sent)) return announced;            // undated: only an announcement can wait for a slip
      return announced
        ? sent <= at + DAY_MS && sent >= at - ANNOUNCE_MAX_AGE_DAYS * DAY_MS
        : Math.abs(sent - at) <= REFUND_AROUND_DAYS * DAY_MS;
    })
    .map(r => ({
      ledgerId: r.ledger_id as number, userId: r.user_id as number, status: r.status as string,
      item: (r.item as string | null) ?? null, amount: (r.amount as number | null) ?? null,
      orderRef: (r.order_ref as string | null) ?? null, merchant: (r.merchant as string | null) ?? null,
      sentAt: (r.sent_at as string | null) ?? null, droppedOffAt: (r.dropoff_at as string | null) ?? null,
    }));
}

/** Pure pairing rule — see the module comment. `slipDay` is YYYY-MM-DD. */
export function pairSlipsWithReturns(slipCount: number, open: OpenReturn[], slipDay: string):
  { close: OpenReturn[]; pending: OpenReturn[] } {
  if (!open.length || slipCount <= 0) return { close: [], pending: [] };
  if (open.length <= slipCount) return { close: open, pending: [] };
  const sameDay = open.filter(o => o.droppedOffAt && o.droppedOffAt.slice(0, 10) >= shiftDay(slipDay, -1) && o.droppedOffAt.slice(0, 10) <= shiftDay(slipDay, 1));
  if (sameDay.length === slipCount) return { close: sameDay, pending: [] };
  return { close: [], pending: open };
}

function shiftDay(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Does a receipt position describe the returned item? Checks the raw names, not the canonical one
 *  ("Dampfbügeleisen" would never match "oliso M3Pro"). */
function positionMatches(p: { name: string | null; original_text: string | null; ai_guess: string | null }, item: string | null): boolean {
  if (!item) return false;
  return [p.name, p.original_text, p.ai_guess].some(n => n && sameReturnItem(n, item, false));
}

/**
 * Close ONE return with a slip: book the full refund of the returned position (unless the user had
 * booked it already), then note the drop-off. Never throws for "could not book" — that becomes a
 * note on the slip and the suggestion stays in the import log for the user.
 */
export async function closeReturnWithSlip(
  r: OpenReturn, slipEinkaufId: number, slipAt: string,
): Promise<{ einkaufId: number | null; note: string | null }> {
  let einkaufId: number | null = null;
  let note: string | null = null;

  if (r.status === 'refund') {
    const [row] = await sql`SELECT einkauf_id FROM imported_email WHERE id = ${r.ledgerId}`;
    einkaufId = (row?.einkauf_id as number | null) ?? null;
  } else {
    const cands = await findRefundCandidates(r.userId, {
      amount: r.amount ?? 0, merchant: r.merchant || 'Amazon', item: r.item ?? '', order_ref: r.orderRef ?? '', datum: slipAt.slice(0, 10),
    });
    const target = cands[0];
    const pos = target ? (await sql`
      SELECT id, name, original_text, ai_guess, menge::float8 AS menge, preis::float8 AS preis
      FROM artikel WHERE einkauf_id = ${target.id} AND NOT is_refund ORDER BY id`) : [];
    const hit = pos.find(p => positionMatches(p as never, r.item));
    if (!target || !hit) {
      note = 'Originalbeleg nicht sicher gefunden — bitte im Importprotokoll zuordnen';
    } else {
      // Units returned: the whole line when it holds one, else what the refund amount pays for.
      const menge = Math.max(1, Math.round(Number(hit.menge) || 1));
      const unit = (Number(hit.preis) || 0) / menge;
      const qty = menge === 1 || !unit || !r.amount ? menge
        : Math.min(menge, Math.max(1, Math.round(r.amount / unit)));
      try {
        const res = await bookRefundReconciliation({
          einkauf_id: target.id, user_id: r.userId, discount_only: false, amount: r.amount ?? 0,
          description: 'Rücksendung' + (r.item ? ' ' + r.item : ''),
          lines: [{ artikel_id: hit.id as number, return_qty: qty }],
          ledger_id: r.ledgerId, refund_email: { imported_email_id: r.ledgerId },
        });
        einkaufId = res.einkauf_id;
      } catch (e) {
        note = e instanceof RefundError ? `Nicht gebucht: ${e.message}` : 'Nicht gebucht: ' + (e as Error).message.slice(0, 120);
      }
    }
  }

  await sql`UPDATE refund_email SET dropoff_at = ${slipAt}::timestamptz, dropoff_einkauf_id = ${slipEinkaufId}
            WHERE imported_email_id = ${r.ledgerId}`;
  return { einkaufId, note };
}

/** The slip's printed date + time as an instant. Read WITHOUT a zone suffix on purpose: the
 *  container runs on Europe/Berlin (see lib/localDate.ts), which is the wall clock the post office
 *  printed. Falls back to now. */
function slipInstant(slip: ReturnSlipResult['slips'][number] | undefined): string {
  if (slip?.datum) {
    const d = new Date(`${slip.datum}T${(slip.uhrzeit ?? '12:00').padStart(5, '0')}:00`);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * A photo turned out to be a return slip: relabel its receipt (0 €, "DHL Retoure → Amazon"),
 * pair it with open Amazon returns and close what the pairing allows. Called from the background
 * OCR, so it must never throw into it.
 */
export async function handleReturnSlip(einkaufId: number, slip: ReturnSlipResult): Promise<RetoureInfo> {
  return withSlipLock(() => handleReturnSlipLocked(einkaufId, slip));
}

async function handleReturnSlipLocked(einkaufId: number, slip: ReturnSlipResult): Promise<RetoureInfo> {
  const first = slip.slips[0];
  const slipAt = slipInstant(first);
  const slipDay = first?.datum ?? slipAt.slice(0, 10);
  const carrier = first?.carrier || 'Paket';
  const toAmazon = slip.slips.some(s => /amazon/i.test(s.recipient));

  // Whose returns? The scanning household member's mailbox first; the whole household as fallback.
  const [who] = await sql`
    SELECT COALESCE(fm.user_id, e.private_for_user_id) AS user_id
    FROM einkauf e LEFT JOIN family_member fm ON fm.id = e.snapped_by_member_id WHERE e.id = ${einkaufId}`;
  const scanner = (who?.user_id as number | null) ?? null;

  // Recognised again (OCR re-run): what this slip already closed stays closed and uses up its slips.
  const prev = await currentInfo(einkaufId);
  const mine = new Set((await sql`
    SELECT imported_email_id AS id FROM refund_email WHERE dropoff_einkauf_id = ${einkaufId}`).map(r => r.id as number));
  const kept = (prev?.closed ?? []).filter(c => mine.has(c.ledgerId));
  const info: RetoureInfo = { slips: slip.slips, closed: kept, pending: null, pendingCount: 0, note: null };
  if (kept.length && prev?.partners?.length) info.partners = prev.partners;
  const slipsLeft = slip.slips.length - kept.length;
  if (!toAmazon) {
    info.note = 'Rücksendezettel erkannt, aber nicht an Amazon — nichts zugeordnet';
  } else if (slipsLeft > 0) {
    let open = await loadOpenReturns(scanner ? [scanner] : null, slipAt);
    if (!open.length && scanner) open = await loadOpenReturns(null, slipAt);
    const { close, pending } = pairSlipsWithReturns(slipsLeft, open, slipDay);
    for (const r of close) {
      const res = await closeReturnWithSlip(r, einkaufId, slipAt);
      info.closed.push({ ledgerId: r.ledgerId, item: r.item, amount: r.amount, einkaufId: res.einkaufId, note: res.note });
    }
    if (pending.length) {
      info.pending = pending.map(p => ({ ledgerId: p.ledgerId, item: p.item, amount: p.amount, orderRef: p.orderRef }));
      info.pendingCount = slipsLeft;
      info.note = chooseNote(pending.length, slipsLeft);
    } else if (kept.length) {
      if (close.length < slipsLeft) info.note = `${slipsLeft - close.length} Zettel ohne angemeldete Rücksendung`;
    } else if (!open.length) {
      // Scanned twice, or the returns were closed by another photo of the same slips?
      const [prev] = await sql`
        SELECT re.dropoff_einkauf_id AS id FROM refund_email re
        WHERE re.dropoff_einkauf_id IS NOT NULL AND re.dropoff_einkauf_id <> ${einkaufId}
          AND re.dropoff_at::date = ${slipDay}::date LIMIT 1`;
      info.note = prev
        ? `Die Rücksendungen dieses Tages sind schon mit Zettel #${prev.id as number} abgeschlossen`
        : 'Keine angemeldete Amazon-Rücksendung gefunden — Rücksende-Mail schon gelabelt?';
    } else if (close.length < slipsLeft) {
      info.note = `${slipsLeft - close.length} Zettel ohne angemeldete Rücksendung`;
    }
  }

  const done = info.pending == null && info.closed.length > 0 && info.closed.every(c => !c.note);
  await sql`
    UPDATE einkauf SET
      roh_ladenname = ${`${carrier} Retoure` + (toAmazon ? ' → Amazon' : '')},
      datum = ${slipDay}::date, gesamt_betrag = 0,
      -- No account: a 0-€ proof of hand-in has no bank booking, and on a Giro account the
      -- completeness check would otherwise keep asking for one.
      konto_id = NULL,
      retoure_info = ${sql.json(info as never)}, geprueft = ${done}
    WHERE id = ${einkaufId}`;
  // Undecided alone may be exact together with the drop-off's other slips (stored above first,
  // so this slip is one of the day's undecided ones).
  if (info.pending) await settlePendingSlips(slipDay);
  await confirmStoreCreditReturns();
  return (await currentInfo(einkaufId)) ?? info;
}

async function currentInfo(einkaufId: number): Promise<RetoureInfo | null> {
  const [row] = await sql`SELECT retoure_info FROM einkauf WHERE id = ${einkaufId}`;
  return (row?.retoure_info as RetoureInfo | null) ?? null;
}

/**
 * Undecided slips of one day settle together. A drop-off's slips are usually photographed one by
 * one (10.11.: two DHL slips, two photos) — each photo alone is "1 slip, 2 open returns", both
 * together are exact. Per household, as long as something moves:
 *   • a slip whose remaining candidates fit its count takes them (also the one left after a pick);
 *   • if all remaining candidates fit the remaining slips, they are dealt out in scan order. Which
 *     slip carried which parcel is printed nowhere, so those slips name each other as partners.
 * Runs under the slip lock.
 */
async function settlePendingSlips(slipDay: string): Promise<void> {
  const rows = await sql`
    SELECT id, retoure_info FROM einkauf
    WHERE datum = ${slipDay}::date AND jsonb_typeof(retoure_info->'pending') = 'array'
    ORDER BY id`;
  if (!rows.length) return;
  const open = new Map((await loadOpenReturns(null, null)).map(o => [o.ledgerId, o]));
  const slips = rows.map(r => {
    const info = r.retoure_info as RetoureInfo;
    return {
      id: r.id as number, info, take: [] as number[],
      cands: (info.pending ?? []).map(p => p.ledgerId).filter(id => open.has(id)),
    };
  });
  type Slip = (typeof slips)[number];
  const used = new Set<number>();
  const left = (s: Slip) => s.info.pendingCount - s.take.length;
  const free = (s: Slip) => s.cands.filter(id => !used.has(id));
  const give = (s: Slip, id: number) => { used.add(id); s.take.push(id); };

  for (let moved = true; moved;) {
    moved = false;
    for (const s of slips) {
      const f = free(s);
      if (left(s) > 0 && f.length > 0 && f.length <= left(s)) { f.forEach(id => give(s, id)); moved = true; }
    }
  }

  const byUser = new Map<number, Slip[]>();
  for (const s of slips) {
    const f = free(s);
    if (left(s) <= 0 || !f.length) continue;
    const uid = open.get(f[0])!.userId;
    byUser.set(uid, [...(byUser.get(uid) ?? []), s]);
  }
  const partners = new Map<number, number[]>();
  for (const group of byUser.values()) {
    const pool = new Set(group.flatMap(free));
    if (group.length < 2 || pool.size > group.reduce((n, s) => n + left(s), 0)) continue;
    for (const s of group) for (const id of free(s)) { if (left(s) <= 0) break; give(s, id); }
    const ids = group.filter(s => s.take.length).map(s => s.id);
    for (const id of ids) partners.set(id, ids.filter(o => o !== id));
  }

  for (const s of slips) {
    const before = s.info.pending ?? [];
    const pruned = before.filter(p => s.cands.includes(p.ledgerId) && !used.has(p.ledgerId));
    if (!s.take.length && pruned.length === before.length) continue;      // nothing changed for it
    const at = slipInstant(s.info.slips[0]);
    for (const id of s.take) {
      const r = open.get(id)!;
      const res = await closeReturnWithSlip(r, s.id, at);
      s.info.closed.push({ ledgerId: id, item: r.item, amount: r.amount, einkaufId: res.einkaufId, note: res.note });
    }
    s.info.pendingCount = Math.max(0, left(s));
    s.info.pending = s.info.pendingCount > 0 && pruned.length ? pruned : null;
    const p = partners.get(s.id);
    if (p?.length) s.info.partners = p;
    s.info.note = s.info.pending ? chooseNote(pruned.length, s.info.pendingCount)
      : !s.info.closed.length ? 'Die angebotenen Rücksendungen sind schon mit anderen Zetteln abgeschlossen'
      : s.info.pendingCount > 0 ? `${s.info.pendingCount} Zettel ohne offene Rücksendung`
      : null;
    const done = s.info.pending == null && s.info.closed.length > 0 && s.info.closed.every(c => !c.note);
    await sql`UPDATE einkauf SET retoure_info = ${sql.json(s.info as never)}, geprueft = ${done} WHERE id = ${s.id}`;
  }
}

/**
 * "Komplett abgeschlossen" on the bank side: a booked, handed-in Amazon return whose credit has
 * now arrived in a CSV. The credit is LINKED to the receipt as evidence (exactly what the manual
 * "Gutschrift zuordnen" does) — never booked a second time. Only an unambiguous 1:1 pairing is taken:
 * same amount to the cent, Amazon as counterparty, booked on or after the drop-off, and no other
 * open return or credit competing for it. Returns how many were confirmed.
 */
export async function confirmReturnsFromBank(kontoId?: number | null): Promise<number> {
  await confirmStoreCreditReturns();   // not a bank match, so not counted — but never left waiting for one
  const open = await sql`
    SELECT re.id, re.einkauf_id, re.dropoff_at::date::text AS dropoff,
           COALESCE((SELECT -a.preis FROM artikel a WHERE a.id = re.refund_artikel_id), re.amount)::float8 AS amount
    FROM refund_email re
    WHERE re.einkauf_id IS NOT NULL AND re.confirmed_at IS NULL AND re.dropoff_at IS NOT NULL
      AND (re.merchant ILIKE '%amazon%' OR re.from_addr ILIKE '%amazon%')`;
  if (!open.length) return 0;
  const credits = await sql`
    SELECT bt.id, bt.amount::float8 AS amount, bt.booking_date::text AS booking
    FROM bank_tx bt
    WHERE bt.amount > 0 AND bt.einkauf_id IS NULL
      AND (bt.counterparty ILIKE '%amazon%' OR bt.description ILIKE '%amazon%')
      AND NOT EXISTS (SELECT 1 FROM income i WHERE i.bank_tx_id = bt.id)
      AND NOT EXISTS (SELECT 1 FROM fixed_cost_check fc WHERE fc.bank_tx_id = bt.id)
      AND NOT EXISTS (SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bt.id)
      ${kontoId ? sql`AND bt.konto_id = ${kontoId}` : sql``}`;
  const fits = (r: (typeof open)[number], c: (typeof credits)[number]) =>
    Math.abs((c.amount as number) - (r.amount as number)) < 0.005
    && String(c.booking) >= shiftDay(String(r.dropoff), -2)
    && String(c.booking) <= shiftDay(String(r.dropoff), 60);
  let confirmed = 0;
  for (const r of open) {
    const mine = credits.filter(c => fits(r, c));
    if (mine.length !== 1) continue;
    const c = mine[0];
    if (open.filter(o => fits(o, c)).length !== 1) continue;   // another return wants the same credit
    const linked = await sql`
      UPDATE bank_tx SET einkauf_id = ${r.einkauf_id as number}
      WHERE id = ${c.id as number} AND einkauf_id IS NULL RETURNING id`;
    if (!linked.length) continue;
    await sql`UPDATE refund_email SET confirmed_at = ${String(c.booking)}::date, confirmed_by = 'bank' WHERE id = ${r.id as number}`;
    confirmed++;
  }
  return confirmed;
}

/** "Komplett abgeschlossen" for Amazon store credit: the refund mail itself says the money went to the
 *  Amazon balance, and no bank booking will ever follow. Sweeps handed-in returns whose refund mail
 *  says so, whichever came first — on 10.11. Amazon refunded both returns an hour BEFORE the slips
 *  were scanned, so the slip's close is what has to notice. An announcement's "wird als Guthaben
 *  gutgeschrieben" is a forecast and never counts. Returns how many were confirmed. */
export async function confirmStoreCreditReturns(): Promise<number> {
  const rows = await sql`
    SELECT re.id, re.subject, re.body_text
    FROM refund_email re
    WHERE re.dropoff_at IS NOT NULL AND re.confirmed_at IS NULL
      AND (re.merchant ILIKE '%amazon%' OR re.from_addr ILIKE '%amazon%')`;
  const ids = rows
    .filter(r => !detectReturnAnnouncement(r.subject as string | null, r.body_text as string | null).isAnnouncement
      && isStoreCreditRefund(r.body_text as string | null))
    .map(r => r.id as number);
  if (!ids.length) return 0;
  await sql`
    UPDATE refund_email SET confirmed_at = COALESCE(sent_at, NOW()), confirmed_by = 'mail'
    WHERE id = ANY(${ids}) AND confirmed_at IS NULL`;
  return ids.length;
}

/** A credit was linked to a receipt by hand ("Gutschrift zuordnen"): if that receipt has a returned,
 *  not yet confirmed Amazon return of exactly this amount, the credit confirms it. */
export async function confirmReturnByBankTx(bankTxId: number): Promise<void> {
  await sql`
    UPDATE refund_email re SET confirmed_at = bt.booking_date, confirmed_by = 'bank'
    FROM bank_tx bt
    WHERE bt.id = ${bankTxId} AND bt.einkauf_id = re.einkauf_id
      AND re.confirmed_at IS NULL AND re.dropoff_at IS NOT NULL
      AND ABS(COALESCE((SELECT -a.preis FROM artikel a WHERE a.id = re.refund_artikel_id), re.amount) - bt.amount) < 0.005`;
}

/** The user picked which open return a still-ambiguous slip belongs to. */
export async function resolveSlipChoice(einkaufId: number, ledgerId: number): Promise<RetoureInfo | { error: string }> {
  return withSlipLock(() => resolveSlipChoiceLocked(einkaufId, ledgerId));
}

async function resolveSlipChoiceLocked(einkaufId: number, ledgerId: number): Promise<RetoureInfo | { error: string }> {
  const [row] = await sql`SELECT retoure_info, datum::text AS datum FROM einkauf WHERE id = ${einkaufId}`;
  const info = row?.retoure_info as RetoureInfo | null;
  if (!info?.pending?.some(p => p.ledgerId === ledgerId)) return { error: 'Diese Rücksendung steht für diesen Zettel nicht zur Wahl.' };
  const open = (await loadOpenReturns(null, null)).find(o => o.ledgerId === ledgerId);
  if (!open) return { error: 'Rücksendung ist schon abgeschlossen.' };
  const slipAt = slipInstant(info.slips[0]);
  const res = await closeReturnWithSlip(open, einkaufId, slipAt);
  info.closed.push({ ledgerId, item: open.item, amount: open.amount, einkaufId: res.einkaufId, note: res.note });
  const rest = info.pending.filter(p => p.ledgerId !== ledgerId);
  info.pendingCount = Math.max(0, info.pendingCount - 1);
  info.pending = info.pendingCount > 0 && rest.length ? rest : null;
  info.note = info.pending ? chooseNote(rest.length, info.pendingCount) : null;
  const done = info.pending == null && info.closed.every(c => !c.note);
  await sql`UPDATE einkauf SET retoure_info = ${sql.json(info as never)}, geprueft = ${done} WHERE id = ${einkaufId}`;
  // One pick can decide the rest: the return left over for this slip, or for the other slips of
  // the drop-off — two slips photographed one by one need a single tap, not two.
  if (row?.datum) await settlePendingSlips(String(row.datum).slice(0, 10));
  await confirmStoreCreditReturns();
  return (await currentInfo(einkaufId)) ?? info;
}
