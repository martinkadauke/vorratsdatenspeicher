import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { kontoScope } from '../auth/konto.js';
import type { User } from '../types.js';

/**
 * Finanzen → Konten: what an account holds, and how it got there.
 *
 * THE RULE, in Martin's words: "Buchung ist Wahrheit, Beleg nur zusätzlich wenn sie jünger sind
 * als der rezenteste CSV import dieses Kontos."
 *
 *   Stand = eingegebener Startwert
 *         + alle Buchungen danach
 *         + alle Belege ohne Buchung, die JÜNGER sind als die letzte Buchung des Kontos
 *
 * The third term is what stops double counting: a receipt the bank has already reported arrives
 * as a booking too, and adding both would subtract the shopping twice.
 *
 * ⚠️ The watermark is max(booking_date), NOT max(imported_at). The import date says when someone
 * uploaded a file; the booking date says how far the bank's data actually reaches. A CSV uploaded
 * today that only covers up to last Friday would otherwise swallow the weekend's receipts —
 * they would count as "already in the bank" while the bank has never heard of them.
 *
 * ⚠️ Accounts with NO bookings at all (cash) have no watermark, so every receipt counts. That is
 * correct — there is no bank feed to double count against — but it means such a balance is only
 * ever as good as the receipts. Cash is excluded from this page for that reason.
 */

/** Types this page is about: the ones a balance means something for. */
export const BALANCE_TYPES = ['giro', 'tagesgeld', 'kreditkarte', 'paypal', 'krypto', 'depot'] as const;

export type Movement = {
  kind: 'buchung' | 'beleg';
  id: number;
  date: string;
  amount: number;
  who: string | null;
  /** buchung: is a receipt linked to it (→ Auszüge). beleg: always false. */
  receipt_id: number | null;
  balance: number;
};

/** The bank's reach for one account — null when it has never seen a booking. */
async function watermark(kontoId: number): Promise<string | null> {
  const [row] = await sql`SELECT max(booking_date)::text AS d FROM bank_tx WHERE konto_id = ${kontoId}`;
  return (row?.d as string | null) ?? null;
}

/**
 * Every movement for one account, oldest first, each carrying the balance AFTER it.
 * Returns [] when the account has no anchor — see the note in `balanceOf`.
 */
export async function movementsOf(kontoId: number, user?: User): Promise<{
  start: number | null; start_date: string | null; water: string | null; movements: Movement[];
}> {
  const [k] = await sql`
    SELECT balance_start::float8 AS start, balance_start_date::text AS start_date
    FROM konto WHERE id = ${kontoId}`;
  if (!k) return { start: null, start_date: null, water: null, movements: [] };

  const water = await watermark(kontoId);
  const from = (k.start_date as string | null) ?? '1900-01-01';

  const bookings = await sql`
    SELECT b.id, b.booking_date::text AS date, b.amount::float8 AS amount,
           COALESCE(b.counterparty, left(b.description, 40)) AS who,
           (SELECT e.id FROM einkauf e WHERE e.bank_tx_id = b.id LIMIT 1) AS receipt_id
    FROM bank_tx b
    WHERE b.konto_id = ${kontoId} AND b.booking_date >= ${from}
    ORDER BY b.booking_date, b.id`;

  // Receipts the bank has not reported yet. Without a watermark (no bookings at all) every
  // receipt qualifies; `bank_tx_id IS NULL` keeps out the ones already represented by a booking.
  const receipts = await sql`
    SELECT e.id, e.datum::text AS date, e.gesamt_betrag::float8 AS total,
           COALESCE(e.roh_ladenname, 'Beleg') AS who
    FROM einkauf e
    WHERE e.konto_id = ${kontoId}
      AND e.bank_tx_id IS NULL
      AND e.gesamt_betrag IS NOT NULL
      AND e.datum >= ${from}
      AND (${water}::date IS NULL OR e.datum > ${water}::date)
      ${kontoScope(user, sql`e`)}
    ORDER BY e.datum, e.id`;

  const merged: Omit<Movement, 'balance'>[] = [
    ...bookings.map(b => ({
      kind: 'buchung' as const, id: b.id as number, date: b.date as string,
      amount: b.amount as number, who: b.who as string | null,
      receipt_id: (b.receipt_id as number | null) ?? null,
    })),
    // A receipt is money leaving the account, so it counts NEGATIVE — gesamt_betrag is stored
    // as a positive sum. Bookings already carry their own sign.
    ...receipts.map(r => ({
      kind: 'beleg' as const, id: r.id as number, date: r.date as string,
      amount: -(r.total as number), who: r.who as string | null, receipt_id: r.id as number,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  let run = (k.start as number | null) ?? 0;
  const movements: Movement[] = merged.map(m => { run += m.amount; return { ...m, balance: run }; });
  return { start: (k.start as number | null), start_date: (k.start_date as string | null), water, movements };
}

/**
 * The account's balance right now — or null when nobody has entered a starting figure.
 *
 * ⚠️ null is deliberate and must survive all the way to the screen. VDS only knows an account
 * from its first import onwards, so without an anchor any absolute number would be invented:
 * the movements are right, the zero point is not. Showing "−482,10 €" for an account that holds
 * three thousand would be worse than showing nothing.
 */
export async function balanceOf(kontoId: number, user?: User): Promise<number | null> {
  const { start, movements } = await movementsOf(kontoId, user);
  if (start === null) return null;
  return movements.length ? movements[movements.length - 1].balance : start;
}

export function accountBalanceRoutes(app: FastifyInstance): void {
  /** All accounts this page covers, with their current balance. */
  app.get('/api/finances/accounts', async (req) => {
    const rows = await sql`
      SELECT k.id, k.name, k.account_type, k.sort_order,
             k.balance_start::float8      AS balance_start,
             k.balance_start_date::text   AS balance_start_date,
             k.low_threshold::float8      AS low_threshold,
             k.low_notified_at IS NOT NULL AS low_notified,
             (SELECT max(b.booking_date)::text FROM bank_tx b WHERE b.konto_id = k.id) AS watermark
      FROM konto k
      WHERE k.account_type = ANY(${BALANCE_TYPES as unknown as string[]})
      ORDER BY k.sort_order, k.name`;

    return Promise.all(rows.map(async k => ({
      ...k,
      balance: await balanceOf(k.id as number, req.user),
    })));
  });

  /** One account's movements, newest first for the screen. */
  app.get<{ Params: { id: string } }>('/api/finances/accounts/:id/movements', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
    const { start, start_date, water, movements } = await movementsOf(id, req.user);
    return { start, start_date, watermark: water, movements: movements.slice().reverse() };
  });

  /**
   * The anchor: "this account held X on day Y". Any writer may set it — it is a statement about
   * reality that whoever is holding the bank app can make.
   */
  app.patch<{ Params: { id: string }; Body: { balance?: number | null; date?: string | null } }>(
    '/api/finances/accounts/:id/balance', async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
      if (req.user && req.user.can_write === false) return reply.code(403).send({ error: 'read_only' });

      const b = req.body ?? {};
      const value = b.balance === null || b.balance === undefined ? null : Number(b.balance);
      if (value !== null && !Number.isFinite(value)) return reply.code(400).send({ error: 'bad_balance' });
      const date = b.date ?? (value === null ? null : new Date().toISOString().slice(0, 10));

      await sql`UPDATE konto SET balance_start = ${value}, balance_start_date = ${date} WHERE id = ${id}`;
      // A new anchor changes the balance, so a standing "already warned" state is stale.
      await sql`UPDATE konto SET low_notified_at = NULL WHERE id = ${id}`;
      return { ok: true, balance: await balanceOf(id, req.user) };
    });

  /**
   * The warning threshold. ADMINS ONLY, at Martin's instruction: on a shared household account
   * this is a promise the household makes to itself, not a personal preference. Everyone who can
   * see the account can READ it — a warning whose reason is invisible is just noise.
   */
  app.patch<{ Params: { id: string }; Body: { threshold?: number | null } }>(
    '/api/finances/accounts/:id/threshold', { preHandler: requireAdmin }, async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' });
      const raw = (req.body ?? {}).threshold;
      const value = raw === null || raw === undefined ? null : Number(raw);
      if (value !== null && !Number.isFinite(value)) return reply.code(400).send({ error: 'bad_threshold' });
      await sql`UPDATE konto SET low_threshold = ${value}, low_notified_at = NULL WHERE id = ${id}`;
      return { ok: true };
    });
}
