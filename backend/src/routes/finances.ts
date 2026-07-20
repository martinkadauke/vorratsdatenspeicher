import type { FastifyInstance } from 'fastify';
import type { TransactionSql } from 'postgres';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import sql, { adminSql } from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { extractPayslip } from '../llm/ocr.js';
import { providerForTask } from '../llm/provider.js';
import { parseLlmJson } from '../llm/ollama.js';
import { parseComdirectCsv } from '../finances/bankCsv.js';
import { sniffCsv, fingerprintHeader, applyCsvMapping, generateCsvMapping, type CsvMappingSpec } from '../finances/csvMapping.js';
import { normMerchant, alignInvoiceToBank } from '../lib/merchant.js';

/** Pay-slip files live in a NON-static subdir of the receipts volume (the static
 *  /receipts/:file route rejects any name containing '/'), so they're reachable
 *  only through the auth-guarded income file endpoint. */
const PAYSLIP_DIR = path.join(process.env.RECEIPTS_LOCAL_PATH ?? '/receipts', '_payslips');
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic',
};

/** Fixed costs (recurring monthly expenses) CRUD — the manual-entry UI the
 *  analytics foundation (mig 040 `fixed_cost` → `v_transactions`) always expected.
 *  Scope is encoded by konto_id: a SHARED konto = household cost (rent, loan…), a
 *  personal konto = that person's cost ("Anthropic" for Martin). No per-row
 *  privacy — household finance planning is shared; can_write is enforced globally
 *  in the auth plugin, so these handlers only need an authenticated user. */
export function financeRoutes(app: FastifyInstance): void {
  const toNum = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const toDate = (v: unknown): string | null => {
    const s = (v ?? '').toString().trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };

  /** Thrown inside sql.begin() to roll the transaction back and surface an HTTP
   *  status to the client (partner-linking validation). */
  class HttpError extends Error {
    constructor(public code: number, message: string) { super(message); }
  }
  type Tx = TransactionSql<Record<string, never>>;

  /** Break a fixed-cost's Umbuchung pairing symmetrically: if `id` has a partner,
   *  null out both sides. No-op if unpaired. */
  async function clearPartner(tx: Tx, id: number): Promise<void> {
    const [row] = await tx`SELECT counterpart_id FROM fixed_cost WHERE id = ${id} FOR UPDATE`;
    const partner = row?.counterpart_id as number | null | undefined;
    if (partner != null) {
      await tx`UPDATE fixed_cost SET counterpart_id = NULL WHERE id IN (${id}, ${partner})`;
    }
  }

  /** Pair two fixed-cost legs of an internal transfer symmetrically, first
   *  detaching any prior partners so the link stays strictly 1:1. */
  async function linkCounterpart(tx: Tx, aId: number, bId: number): Promise<void> {
    await clearPartner(tx, aId);
    await clearPartner(tx, bId);
    await tx`UPDATE fixed_cost SET counterpart_id = ${bId} WHERE id = ${aId}`;
    await tx`UPDATE fixed_cost SET counterpart_id = ${aId} WHERE id = ${bId}`;
  }

  /** All fixed costs with their konto scope (household vs which person). */
  app.get('/api/fixed-costs', async () => {
    return sql`
      SELECT f.id, f.label, f.category_path, f.monthly_eur::float8 AS monthly_eur, f.kind, f.frequency, f.is_transfer,
             f.konto_id, f.start_date::text AS start_date, f.end_date::text AS end_date, f.active, f.one_off,
             f.expect_receipt, f.match_merchant, f.counterpart_id,
             cp.label AS counterpart_label, ck.name AS counterpart_konto,
             k.name AS konto_name, k.is_shared, k.user_id AS konto_user_id, u.username AS owner
      FROM fixed_cost f
      LEFT JOIN konto k ON k.id = f.konto_id
      LEFT JOIN users u ON u.id = k.user_id
      LEFT JOIN fixed_cost cp ON cp.id = f.counterpart_id
      LEFT JOIN konto ck ON ck.id = cp.konto_id
      ORDER BY f.active DESC, k.is_shared DESC, u.username NULLS FIRST, f.label
    `;
  });

  app.post('/api/fixed-costs', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const label = (b.label ?? '').toString().trim();
    const monthly = toNum(b.monthly_eur);
    const kontoId = b.konto_id != null ? parseInt(String(b.konto_id), 10) : null;
    const start = toDate(b.start_date) ?? new Date().toISOString().slice(0, 10);
    const end = toDate(b.end_date);
    const category = (b.category_path ?? '').toString().trim() || null;
    if (!label) return reply.code(400).send({ error: 'label required' });
    if (monthly == null) return reply.code(400).send({ error: 'monthly_eur required' }); // negatives allowed (= recurring credit/income)
    if (!kontoId) return reply.code(400).send({ error: 'konto_id required' });
    const kind = b.kind === 'income' ? 'income' : 'expense';
    const freq = ['monthly', 'quarterly', 'yearly'].includes(String(b.frequency)) ? String(b.frequency) : 'monthly';
    const isTransfer = b.is_transfer === true;
    const oneOff = b.one_off === true;   // preserved on undo-delete (readd); default false for manual creates
    const cpId = b.counterpart_id != null ? parseInt(String(b.counterpart_id), 10) : null;
    try {
      const id = await sql.begin(async tx => {
        const [row] = await tx`
          INSERT INTO fixed_cost (label, category_path, monthly_eur, kind, frequency, is_transfer, konto_id, start_date, end_date, active, expect_receipt, match_merchant, one_off, created_by)
          VALUES (${label}, ${category}, ${monthly}, ${kind}, ${freq}, ${isTransfer}, ${kontoId}, ${start}, ${end}, ${b.active !== false},
                  ${b.expect_receipt !== false}, ${(b.match_merchant ?? '').toString().trim() || null}, ${oneOff}, ${req.user?.id ?? null})
          RETURNING id`;
        if (cpId) {
          if (!isTransfer) throw new HttpError(400, 'Nur Umbuchungen können eine Gegenbuchung haben');
          const [partner] = await tx`SELECT id, is_transfer, konto_id FROM fixed_cost WHERE id = ${cpId} FOR UPDATE`;
          if (!partner) throw new HttpError(400, 'Gegenbuchung nicht gefunden');
          if (!partner.is_transfer) throw new HttpError(400, 'Die Gegenbuchung muss ebenfalls als Umbuchung markiert sein');
          if (kontoId === partner.konto_id) throw new HttpError(400, 'Umbuchung und Gegenbuchung müssen auf verschiedenen Konten liegen');
          await linkCounterpart(tx, row.id as number, cpId);
        }
        return row.id as number;
      });
      return { ok: true, id };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.code).send({ error: e.message });
      throw e;
    }
  });

  app.patch('/api/fixed-costs/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    if ('label' in b) {
      const l = (b.label ?? '').toString().trim();
      if (!l) return reply.code(400).send({ error: 'label cannot be empty' });
      updates.label = l;
    }
    if ('monthly_eur' in b) {
      const m = toNum(b.monthly_eur);
      if (m == null) return reply.code(400).send({ error: 'monthly_eur invalid' }); // negatives allowed
      updates.monthly_eur = m;
    }
    if ('konto_id' in b) {
      const k = b.konto_id != null ? parseInt(String(b.konto_id), 10) : null;
      if (!k) return reply.code(400).send({ error: 'konto_id required' });
      updates.konto_id = k;
    }
    if ('category_path' in b) updates.category_path = (b.category_path ?? '').toString().trim() || null;
    if ('start_date' in b) { const d = toDate(b.start_date); if (d) updates.start_date = d; }
    if ('end_date' in b) updates.end_date = toDate(b.end_date); // null clears it
    if ('active' in b) updates.active = !!b.active;
    if ('expect_receipt' in b) updates.expect_receipt = b.expect_receipt !== false;
    if ('match_merchant' in b) updates.match_merchant = (b.match_merchant ?? '').toString().trim() || null;
    if ('kind' in b) updates.kind = b.kind === 'income' ? 'income' : 'expense';
    if ('frequency' in b) updates.frequency = ['monthly', 'quarterly', 'yearly'].includes(String(b.frequency)) ? String(b.frequency) : 'monthly';
    if ('is_transfer' in b) updates.is_transfer = b.is_transfer === true;
    const hasCp = 'counterpart_id' in b;
    const cpId = hasCp && b.counterpart_id != null ? parseInt(String(b.counterpart_id), 10) : null;
    if (hasCp && b.counterpart_id != null && (!cpId || cpId === id)) return reply.code(400).send({ error: 'invalid counterpart_id' });
    if (!Object.keys(updates).length && !hasCp) return reply.code(400).send({ error: 'no patchable fields' });
    try {
      await sql.begin(async tx => {
        if (Object.keys(updates).length) {
          const [row] = await tx`UPDATE fixed_cost SET ${tx(updates)} WHERE id = ${id} RETURNING id`;
          if (!row) throw new HttpError(404, 'not found');
        }
        // A row that is no longer an Umbuchung must not keep a Gegenbuchung link.
        if (updates.is_transfer === false) await clearPartner(tx, id);
        if (hasCp) {
          const [a] = await tx`SELECT id, is_transfer, konto_id, counterpart_id FROM fixed_cost WHERE id = ${id} FOR UPDATE`;
          if (!a) throw new HttpError(404, 'not found');
          if (cpId == null) {
            await clearPartner(tx, id);
          } else if (a.counterpart_id !== cpId) {
            // Already linked to this partner → nothing to do (ordinary edits re-send
            // counterpart_id; don't rewrite the partner row for no reason).
            const [partner] = await tx`SELECT id, is_transfer, konto_id FROM fixed_cost WHERE id = ${cpId} FOR UPDATE`;
            if (!partner) throw new HttpError(400, 'Gegenbuchung nicht gefunden');
            if (!a.is_transfer || !partner.is_transfer) throw new HttpError(400, 'Beide Buchungen müssen als Umbuchung markiert sein');
            if (a.konto_id === partner.konto_id) throw new HttpError(400, 'Umbuchung und Gegenbuchung müssen auf verschiedenen Konten liegen');
            await linkCounterpart(tx, id, cpId);
          }
        }
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.code).send({ error: e.message });
      throw e;
    }
  });

  app.delete('/api/fixed-costs/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    await sql`DELETE FROM fixed_cost WHERE id = ${id}`;
    return { ok: true };
  });

  /** Bank bookings that could be this transfer leg's Gegenbuchung: opposite sign,
   *  matching amount, on a DIFFERENT account, still unlinked. */
  app.get('/api/finances/fixed-cost/:id/bank-counterpart-candidates', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const [f] = await sql`SELECT monthly_eur::float8 AS amount, kind, konto_id, is_transfer FROM fixed_cost WHERE id = ${id}`;
    if (!f || f.is_transfer !== true) return { candidates: [] };
    const amt = f.amount as number;
    const tol = Math.max(0.5, amt * 0.02);
    const rows = await sql`
      SELECT bt.id, bt.konto_id, k.name AS konto_name, bt.booking_date::text AS datum, bt.amount::float8 AS amount, bt.counterparty
      FROM bank_tx bt LEFT JOIN konto k ON k.id = bt.konto_id
      WHERE ABS(ABS(bt.amount) - ${amt}) <= ${tol}
        AND ${f.kind === 'income' ? sql`bt.amount < 0` : sql`bt.amount > 0`}
        AND bt.konto_id IS DISTINCT FROM ${f.konto_id}
        AND bt.einkauf_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bt.id)
        AND NOT EXISTS (SELECT 1 FROM income i WHERE i.bank_tx_id = bt.id)
        AND NOT EXISTS (SELECT 1 FROM fixed_cost_check fc WHERE fc.bank_tx_id = bt.id)
      ORDER BY bt.booking_date DESC LIMIT 20`;
    return { candidates: rows };
  });

  /** Pair this transfer leg with a bank booking in ONE step: auto-create the opposite
   *  Fixkosten leg from the booking (one-month, Umbuchung), link the booking to it as
   *  confirmed evidence, and pair the two legs symmetrically. */
  app.post('/api/finances/fixed-cost/:id/counterpart-from-bank', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const bankTxId = parseInt(String((req.body as { bank_tx_id?: number } | undefined)?.bank_tx_id ?? ''), 10);
    if (!bankTxId) return reply.code(400).send({ error: 'bank_tx_id required' });
    try {
      const counterpartId = await sql.begin(async tx => {
        const [f] = await tx`SELECT label, kind, konto_id, is_transfer FROM fixed_cost WHERE id = ${id} FOR UPDATE`;
        if (!f) throw new HttpError(404, 'not found');
        if (f.is_transfer !== true) throw new HttpError(400, 'Nur Umbuchungen können eine Gegenbuchung haben');
        const [bt] = await tx`SELECT konto_id, booking_date::text AS booking, amount::float8 AS amount, einkauf_id FROM bank_tx WHERE id = ${bankTxId} FOR UPDATE`;
        if (!bt) throw new HttpError(400, 'Bankbuchung nicht gefunden');
        if (bt.konto_id == null) throw new HttpError(400, 'Buchung ohne Konto');
        if (bt.konto_id === f.konto_id) throw new HttpError(400, 'Gegenbuchung muss auf einem anderen Konto liegen');
        const [st] = await tx`SELECT
          EXISTS(SELECT 1 FROM einkauf WHERE bank_tx_id = ${bankTxId}) AS r,
          EXISTS(SELECT 1 FROM income WHERE bank_tx_id = ${bankTxId}) AS i,
          EXISTS(SELECT 1 FROM fixed_cost_check WHERE bank_tx_id = ${bankTxId}) AS f`;
        // bt.einkauf_id → this booking is already a split-shipment sibling of a receipt.
        if (st.r || st.i || st.f || bt.einkauf_id != null) throw new HttpError(400, 'Bankbuchung ist bereits zugeordnet');
        const oppKind = f.kind === 'income' ? 'expense' : 'income';
        const amount = Math.abs(bt.amount as number);
        const month = String(bt.booking).slice(0, 7);
        const mb = monthBounds(month);
        if (!mb) throw new HttpError(400, 'bad booking date');
        const start = `${month}-01`;
        const [nf] = await tx`
          INSERT INTO fixed_cost (label, category_path, monthly_eur, kind, frequency, is_transfer, konto_id, start_date, end_date, active, expect_receipt, match_merchant, one_off, created_by)
          VALUES (${(f.label as string | null) ?? 'Umbuchung'}, NULL, ${amount}, ${oppKind}, 'monthly', TRUE, ${bt.konto_id}, ${start}, ${mb.last}, TRUE, FALSE, NULL, TRUE, ${req.user?.id ?? null})
          RETURNING id`;
        await tx`
          INSERT INTO fixed_cost_check (fixed_cost_id, month, status, bank_tx_id, amount, decided_by)
          VALUES (${nf.id}, ${start}, 'confirmed', ${bankTxId}, ${amount}, ${req.user?.id ?? null})
          ON CONFLICT (fixed_cost_id, month) DO UPDATE SET bank_tx_id = EXCLUDED.bank_tx_id, amount = EXCLUDED.amount, status = 'confirmed'`;
        await linkCounterpart(tx, id, nf.id as number);
        return nf.id as number;
      });
      return { ok: true, counterpart_id: counterpartId };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.code).send({ error: e.message });
      throw e;
    }
  });

  // ── Monatsansicht ─────────────────────────────────────────────────────────

  const monthBounds = (m: string): { first: string; last: string } | null => {
    if (!/^\d{4}-\d{2}$/.test(m)) return null;
    const [y, mo] = m.split('-').map(Number);
    if (mo < 1 || mo > 12) return null;
    const first = `${m}-01`;
    const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); // day 0 of next month
    return { first, last };
  };
  // Check "anchor" month: monthly costs are checked per month; quarterly costs
  // share one check across their quarter, yearly across their year — so a single
  // quarterly/yearly invoice, confirmed once, covers every month of that period.
  const anchorMonth = (firstOfMonth: string, freq: string | null | undefined): string => {
    const [y, mo] = firstOfMonth.split('-').map(Number);
    if (freq === 'quarterly') return `${y}-${String(Math.floor((mo - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
    if (freq === 'yearly') return `${y}-01-01`;
    return firstOfMonth;
  };

  /** Everything the month view needs: fixed-cost checklist (state + suggestion)
   *  and budget rows (forecast / target / actual). Matching is deliberately a
   *  self-contained, deterministic step here — when bank-CSV transactions arrive
   *  as a second evidence source, they slot in as additional candidates. */
  app.get('/api/finances/month', async (req, reply) => {
    const m = ((req.query as { month?: string }).month ?? '').trim();
    const b = monthBounds(m);
    if (!b) return reply.code(400).send({ error: 'month must be YYYY-MM' });

    // Optional account scope (holder/household views): a comma list of konto_ids.
    // Absent → whole household (all accounts). This is what makes internal
    // transfers net out: a "Beitrag" expense on a personal account and its income
    // on the household account both show only when both accounts are in scope.
    const kraw = ((req.query as { konten?: string }).konten ?? '').trim();
    const kIds = kraw ? kraw.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite) : null;
    const fixKonto = kIds && kIds.length ? sql`AND f.konto_id = ANY(${kIds})` : sql``;
    const budKonto = kIds && kIds.length ? sql`AND (bu.konto_id = ANY(${kIds}) OR bu.konto_id IS NULL)` : sql``;
    // Variable-cost actuals are attributed to the account the RECEIPT was charged to
    // (einkauf.konto_id), whose owner defines the person/household scope — NOT the
    // snapper (any member may hold the household card). Scope the budget sums by it.
    const sumsKonto = kIds && kIds.length ? sql`AND e.konto_id = ANY(${kIds})` : sql``;

    // 1) Recurring plans active this month + their check. `kind` splits them into
    //    expenses (Fixkosten) and income (Einnahmen-Soll); both share the same
    //    check + evidence-matching engine, just against different evidence pools.
    const fixed = await sql`
      SELECT f.id, f.label, f.monthly_eur::float8 AS monthly_eur, f.kind, f.frequency, f.is_transfer, f.expect_receipt, f.match_merchant,
             f.one_off, f.counterpart_id,
             f.konto_id, k.name AS konto_name, k.is_shared, u.username AS owner,
             c.id AS check_id, c.status AS check_status, c.einkauf_id AS check_einkauf_id,
             c.bank_tx_id AS check_bank_tx_id, c.income_id AS check_income_id, c.amount::float8 AS check_amount,
             CASE WHEN c.einkauf_id IS NOT NULL THEN 'receipt'
                  WHEN c.bank_tx_id IS NOT NULL THEN 'bank'
                  WHEN c.income_id IS NOT NULL THEN 'income' ELSE 'none' END AS check_source,
             ce.bank_tx_id AS ce_bank, ice.bank_tx_id AS ice_bank, ice.file_path AS ice_file,
             COALESCE(ce.roh_ladenname, bce.counterparty, ice.description) AS check_laden,
             COALESCE(ce.datum::text, bce.booking_date::text, ice.datum::text) AS check_datum
      FROM fixed_cost f
      LEFT JOIN konto k ON k.id = f.konto_id
      LEFT JOIN users u ON u.id = k.user_id
      LEFT JOIN fixed_cost_check c ON c.fixed_cost_id = f.id AND c.month = (
        CASE f.frequency
          WHEN 'quarterly' THEN date_trunc('quarter', ${b.first}::date)::date
          WHEN 'yearly' THEN date_trunc('year', ${b.first}::date)::date
          ELSE ${b.first}::date
        END)
      LEFT JOIN einkauf ce ON ce.id = c.einkauf_id
      LEFT JOIN bank_tx bce ON bce.id = c.bank_tx_id
      LEFT JOIN income ice ON ice.id = c.income_id
      WHERE f.active AND f.start_date <= ${b.last} AND (f.end_date IS NULL OR f.end_date >= ${b.first})
        ${fixKonto}
      ORDER BY k.is_shared DESC NULLS LAST, u.username NULLS FIRST, f.label
    `;

    // 2) Candidate receipts of the month (visibility-scoped) for suggestion matching.
    //    Fixed costs (rent, internet, subscriptions …) NEVER appear on a till
    //    receipt — they arrive as invoices (e-mail import = 'email', or a dropped
    //    invoice PDF = legacy 'upload'), later as bank-CSV rows, or have no receipt
    //    at all. So Kassenbons ('zettel') and cash ('bar') must never be offered as
    //    evidence — only invoice-type sources. (Manual app entries are zettel/bar,
    //    so 'upload' only ever means a dropped invoice PDF.)
    // Evidence candidates are pulled for the whole YEAR of the viewed month, so a quarterly
    // or yearly plan can match its single payment in ANY month of its period (each plan is
    // filtered back to its own period in the matching loop below). A monthly plan is filtered
    // to just this month, so nothing changes for it.
    const evYear = b.first.slice(0, 4);
    const yLo = `${evYear}-01-01`, yHi = `${evYear}-12-31`;
    const receipts = await sql`
      SELECT e.id, e.datum::text AS datum, e.roh_ladenname, e.gesamt_betrag::float8 AS gesamt_betrag
      FROM einkauf e
      WHERE e.datum BETWEEN ${yLo} AND ${yHi} AND e.gesamt_betrag IS NOT NULL
        AND e.quelle IN ('email', 'upload')
        ${kontoScope(req.user, sql`e`)}
    `;
    // Bank transactions of the year (both signs) + actual income rows (pay slips)
    // — the evidence for income plans. Expense plans match invoices + bank debits;
    // income plans match income rows + bank credits.
    const banktx = await sql`
      SELECT bt.id, bt.booking_date::text AS datum, bt.counterparty, bt.description, bt.amount::float8 AS amount,
             (bt.einkauf_id IS NOT NULL OR EXISTS(SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bt.id)) AS receipt_linked
      FROM bank_tx bt
      WHERE bt.booking_date BETWEEN ${yLo} AND ${yHi}
    `;
    const income = await sql`
      SELECT i.id, i.datum::text AS datum, i.amount::float8 AS amount, i.source, i.description,
             i.konto_id, k.name AS konto_name, k.is_shared, u.username AS owner
      FROM income i
      LEFT JOIN konto k ON k.id = i.konto_id
      LEFT JOIN users u ON u.id = k.user_id
      WHERE i.datum BETWEEN ${yLo} AND ${yHi}
      ORDER BY i.amount DESC, i.id DESC`;
    // Two evidence pools; a candidate is keyed "<source>:<id>" so one piece of
    // evidence never serves two positions and a confirmed one is never re-suggested.
    type Ev = { source: 'receipt' | 'bank' | 'income'; id: number; laden: string | null; betrag: number; datum: string; linked: boolean };
    // Match merchant on the COUNTERPARTY only, not counterparty+description: card
    // payments carry "Kartenzahlung comdirect Visa-Debitkarte …" boilerplate in the
    // description, which would false-match e.g. a "Comdirect" fixed cost to every card
    // purchase. The counterparty is the real vendor ("Lidl sagt Danke", "Telekom …").
    // `linked` = this debit is already a receipt's payment. The AUTO-SUGGESTION skips them
    // (a fixed cost must never grab a debit that belongs to a receipt); the manual picker
    // still surfaces them, greyed-out, so you can see where a debit went.
    const evExpense: Ev[] = [
      ...receipts.map(r => ({ source: 'receipt' as const, id: r.id as number, laden: r.roh_ladenname as string | null, betrag: r.gesamt_betrag as number, datum: String(r.datum), linked: false })),
      ...banktx.filter(bt => (bt.amount as number) < 0).map(bt => ({ source: 'bank' as const, id: bt.id as number, laden: bt.counterparty as string | null, betrag: Math.abs(bt.amount as number), datum: String(bt.datum), linked: bt.receipt_linked === true })),
    ];
    const evIncome: Ev[] = [
      ...income.map(i => ({ source: 'income' as const, id: i.id as number, laden: i.description as string | null, betrag: i.amount as number, datum: String(i.datum), linked: false })),
      ...banktx.filter(bt => (bt.amount as number) > 0).map(bt => ({ source: 'bank' as const, id: bt.id as number, laden: bt.counterparty as string | null, betrag: bt.amount as number, datum: String(bt.datum), linked: false })),
    ];
    const usedKeys = new Set<string>();
    for (const f of fixed) {
      if (f.check_einkauf_id) usedKeys.add(`receipt:${f.check_einkauf_id}`);
      if (f.check_bank_tx_id) usedKeys.add(`bank:${f.check_bank_tx_id}`);
      if (f.check_income_id) usedKeys.add(`income:${f.check_income_id}`);
    }
    // Evidence already confirmed for ANY month/position never gets re-suggested.
    const confirmedElsewhere = new Set<string>();
    for (const r of await sql`SELECT einkauf_id, bank_tx_id, income_id FROM fixed_cost_check WHERE einkauf_id IS NOT NULL OR bank_tx_id IS NOT NULL OR income_id IS NOT NULL`) {
      if (r.einkauf_id) confirmedElsewhere.add(`receipt:${r.einkauf_id}`);
      if (r.bank_tx_id) confirmedElsewhere.add(`bank:${r.bank_tx_id}`);
      if (r.income_id) confirmedElsewhere.add(`income:${r.income_id}`);
    }

    // "Complete" = this month's row is fully reconciled for the Zugeordnet-%.
    //  Needs BOTH: a bank booking linked (the actual payment — directly or via the
    //  married receipt/income row) AND the receipt question resolved (invoice/receipt
    //  attached, income pay slip, "kein Beleg" = expect_receipt false, OR an internal
    //  transfer which has no receipt by nature). A deliberately skipped month counts
    //  as done. NB: a plan with no monthly check is NOT complete — even when globally
    //  marked no-receipt — because the payment still has to be matched to a booking;
    //  such a row therefore stays actionable ("Verknüpfen") instead of auto-passing.
    const isComplete = (f: typeof fixed[number]): boolean => {
      if (!f.check_id) return false;
      if (f.check_status === 'skipped') return true;
      const bankLinked = f.check_bank_tx_id != null || f.ce_bank != null || f.ice_bank != null;
      const receiptResolved = f.check_source === 'receipt'
        || (f.kind === 'income' && f.ice_file != null)
        || f.expect_receipt === false
        || f.is_transfer === true;
      return bankLinked && receiptResolved;
    };

    // Deterministic suggestion: merchant match (learned match_merchant, else label
    // tokens) and/or amount within ±max(1 €, 2 %). Greedy: best score first, one
    // piece of evidence serves at most one position.
    type Cand = { fixedId: number; source: 'receipt' | 'bank' | 'income'; einkaufId: number | null; bankTxId: number | null; incomeId: number | null; score: number; laden: string | null; betrag: number; datum: string; amountOk: boolean; merchantOk: boolean; amtDiff: number };
    const cands: Cand[] = [];
    for (const f of fixed) {
      // Skip only FULLY reconciled (or deliberately skipped) rows. A PARTIAL check —
      // e.g. an income plan with its pay slip but no bank credit yet — still gets its
      // MISSING leg suggested (the check's own legs are already in usedKeys, so only
      // the gap is offered). Fixes: no re-proposal after a plan is re-activated.
      if (isComplete(f)) continue;
      // A no-receipt plan (Kindergeld, rent, Kredit …) still needs its BANK payment
      // suggested — it just never has an invoice/pay slip, so offer bank evidence only
      // (don't propose a coincidental receipt for something that has none).
      const noReceipt = f.expect_receipt === false;
      // A plan's evidence may fall anywhere in its PERIOD (a quarterly/yearly payment lands
      // in one month of the quarter/year); a monthly plan is bounded to the viewed month.
      const per = periodBounds(b, f.frequency as string);
      const pool = (f.kind === 'income' ? evIncome : evExpense)
        .filter(ev => !noReceipt || ev.source === 'bank')
        .filter(ev => !ev.linked)                                  // never auto-grab a receipt's own debit
        .filter(ev => ev.datum >= per.lo && ev.datum <= per.hi);
      const target = f.monthly_eur as number;
      const tol = Math.max(1, Math.abs(target) * 0.02);
      const needle = normMerchant((f.match_merchant as string | null) ?? '');
      const labelToks = normMerchant(f.label as string).split(' ').filter(w => w.length >= 4);
      for (const ev of pool) {
        const key = `${ev.source}:${ev.id}`;
        if (usedKeys.has(key) || confirmedElsewhere.has(key)) continue;
        const laden = normMerchant(ev.laden ?? '');
        const amountOk = Math.abs(ev.betrag - target) <= tol;
        // Merchant match: the learned merchant (or a label token) is in the evidence's
        // counterparty — OR the reverse, when the learned merchant is MORE verbose than
        // the counterparty (a pay slip's "Employer · Brutto 6250 €" vs the bank's plain
        // "Employer"), so a variable salary still matches its Gutschrift by name.
        const merchantHit = !!needle && (laden.includes(needle) || (laden.length >= 6 && needle.includes(laden)));
        const merchantOk = merchantHit || labelToks.some(tk => laden.includes(tk));
        if (!amountOk && !merchantOk) continue;
        cands.push({
          fixedId: f.id as number, source: ev.source,
          einkaufId: ev.source === 'receipt' ? ev.id : null, bankTxId: ev.source === 'bank' ? ev.id : null, incomeId: ev.source === 'income' ? ev.id : null,
          score: (merchantOk ? 2 : 0) + (amountOk ? 1 : 0) + (merchantHit ? 1 : 0),
          laden: ev.laden, betrag: ev.betrag, datum: ev.datum, amountOk, merchantOk,
          amtDiff: Math.abs(ev.betrag - target),
        });
      }
    }
    // Best score first, then the closest amount (receipt-linked debits are already out of
    // the pool, so a periodic plan can only match a genuinely-open payment).
    cands.sort((a, c) => (c.score - a.score) || (a.amtDiff - c.amtDiff));
    const sugByFixed = new Map<number, Cand>();
    const takenKeys = new Set<string>();
    for (const c of cands) {
      const key = `${c.source}:${c.einkaufId ?? c.bankTxId ?? c.incomeId}`;
      if (sugByFixed.has(c.fixedId) || takenKeys.has(key)) continue;
      sugByFixed.set(c.fixedId, c);
      takenKeys.add(key);
    }

    // 3) Budgets: actual (this month) + forecast (median of the 3 previous months).
    //    Receipts confirmed as fixed-cost evidence are excluded from the variable sums.
    const budgets = await sql`
      SELECT bu.id, bu.label, bu.monthly_target::float8 AS monthly_target, bu.konto_id, bu.active,
             k.name AS konto_name, k.is_shared, u.username AS owner,
             COALESCE(ARRAY_AGG(bc.category_path ORDER BY bc.category_path) FILTER (WHERE bc.category_path IS NOT NULL), '{}') AS categories
      FROM budget bu
      LEFT JOIN konto k ON k.id = bu.konto_id
      LEFT JOIN users u ON u.id = k.user_id
      LEFT JOIN budget_category bc ON bc.budget_id = bu.id
      WHERE bu.active ${budKonto}
      GROUP BY bu.id, k.name, k.is_shared, u.username
      ORDER BY bu.label
    `;
    // The 3 calendar months before the current one (for the forecast median). Kept as
    // explicit keys so a month with NO spend enters the median as 0 (a real €0 month),
    // instead of being silently dropped and biasing the forecast upward.
    const priorKeys: string[] = [];
    for (let k = 3; k >= 1; k--) priorKeys.push(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 - k, 1)).toISOString().slice(0, 10));
    const prevFirst = priorKeys[0];
    const sums = await sql`
      SELECT bu.id AS budget_id, date_trunc('month', e.datum)::date::text AS mon, SUM(a.preis)::float8 AS total
      FROM budget bu
      JOIN artikel a ON a.preis IS NOT NULL AND a.category_path IS NOT NULL
        AND EXISTS (SELECT 1 FROM budget_category bc WHERE bc.budget_id = bu.id
                    AND (a.category_path = bc.category_path OR a.category_path LIKE bc.category_path || '/%'))
      JOIN einkauf e ON e.id = a.einkauf_id
      WHERE bu.active AND e.datum BETWEEN ${prevFirst} AND ${b.last}
        AND (bu.konto_id IS NULL OR e.konto_id = bu.konto_id)
        ${sumsKonto}
        -- Exclude a receipt that is a fixed cost's confirmed bill — via the receipt link OR
        -- the bank link (an e-mailed Internet/phone bill is verified through its bank booking,
        -- so fc.einkauf_id alone misses it and it double-counts the fixed cost in the budget).
        AND NOT EXISTS (
          SELECT 1 FROM fixed_cost_check fc
          WHERE fc.einkauf_id = e.id OR (fc.bank_tx_id IS NOT NULL AND fc.bank_tx_id = e.bank_tx_id)
        )
      GROUP BY bu.id, date_trunc('month', e.datum)
    `;
    // NB: no PRIVACY kontoScope here on purpose — a private receipt still counts toward
    // the budget total; the drill-down masks its details for non-owners. (The account
    // scope above, sumsKonto, is a different thing: which account was charged.)
    // NB: the EXISTS match (not a JOIN on budget_category) is deliberate: an artikel that
    // falls under BOTH a parent and a nested child category of the SAME budget must count
    // ONCE, not once per matching category row.
    const actualBy = new Map<number, number>();
    const histByMonth = new Map<number, Map<string, number>>();
    for (const s of sums) {
      const mon = String(s.mon);
      if (mon === b.first) actualBy.set(s.budget_id as number, s.total as number);
      else {
        let mm = histByMonth.get(s.budget_id as number);
        if (!mm) { mm = new Map<string, number>(); histByMonth.set(s.budget_id as number, mm); }
        mm.set(mon, s.total as number);
      }
    }
    const median = (xs: number[]): number | null => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, c) => a - c);
      return Math.round(s[Math.floor((s.length - 1) / 2)] * 100) / 100;
    };
    // Forecast = median of the 3 prior months, a month with no matching spend counted
    // as 0. A budget with NO prior spend at all keeps a null forecast ("–") rather than
    // a misleading €0 (no history to base a forecast on).
    const forecastBy = new Map<number, number | null>();
    for (const [bid, mm] of histByMonth) forecastBy.set(bid, median(priorKeys.map(k => mm.get(k) ?? 0)));

    // "Unbudgetiert": this month's variable spend in categories NOT covered by any active
    // budget — so the month view reflects ALL variable spend, even before every category
    // has a budget. Meta (Pfand/Rabatt) is a real category too: it counts here until the
    // user gives it a budget. Only a receipt already confirmed as a fixed cost's evidence
    // (fixed_cost_check) is excluded — it counts ONCE as that fixed cost, never here.
    // ⚠️ A receipt in a category you ALSO run as a fixed cost still double-counts (fixed
    // plan + here) UNLESS you link it to that fixed cost — same rule as budgets.
    const [unbudget] = await sql`
      SELECT COALESCE(SUM(a.preis), 0)::float8 AS actual
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.preis IS NOT NULL AND a.category_path IS NOT NULL
        AND e.datum BETWEEN ${b.first} AND ${b.last}
        ${sumsKonto}
        -- Not a fixed cost's confirmed bill — via the receipt link OR the bank link (an
        -- e-mailed Internet/phone bill is a separate einkauf verified through its bank
        -- booking, so fc.einkauf_id alone misses it and it would double-count the fixed cost).
        AND NOT EXISTS (
          SELECT 1 FROM fixed_cost_check fc
          WHERE fc.einkauf_id = e.id OR (fc.bank_tx_id IS NOT NULL AND fc.bank_tx_id = e.bank_tx_id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM budget bu JOIN budget_category bc ON bc.budget_id = bu.id
          WHERE bu.active AND (bu.konto_id IS NULL OR e.konto_id = bu.konto_id)
            AND (a.category_path = bc.category_path OR a.category_path LIKE bc.category_path || '/%')
        )
    `;

    // Total RECEIPT spend this month: EVERY variable receipt line counted exactly ONCE, so
    // overlapping budgets (e.g. "Lebensmittel" and a nested "Obst") can never inflate it.
    // Includes UNCATEGORISED lines (categorisation can fail) AND Meta/Pfand/Rabatt (a real
    // category — deposits add, discounts subtract, so the total equals what was actually
    // paid). Drops only fixed-cost bills (via receipt- OR bank-link). NOT the sum of budgets.
    const [receiptRow] = await sql`
      SELECT COALESCE(SUM(a.preis), 0)::float8 AS total
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.preis IS NOT NULL
        AND e.datum BETWEEN ${b.first} AND ${b.last}
        ${sumsKonto}
        AND NOT EXISTS (
          SELECT 1 FROM fixed_cost_check fc
          WHERE fc.einkauf_id = e.id OR (fc.bank_tx_id IS NOT NULL AND fc.bank_tx_id = e.bank_tx_id)
        )
    `;
    // Of that, the "Kategorie fehlt" slice: priced lines the AI never categorised. Same
    // exclusions. Surfaced as its own bucket so failed categorisation is visible + fixable.
    const [catMissing] = await sql`
      SELECT COALESCE(SUM(a.preis), 0)::float8 AS total
      FROM artikel a JOIN einkauf e ON e.id = a.einkauf_id
      WHERE a.preis IS NOT NULL AND (a.category_path IS NULL OR a.category_path = '')
        AND e.datum BETWEEN ${b.first} AND ${b.last}
        ${sumsKonto}
        AND NOT EXISTS (
          SELECT 1 FROM fixed_cost_check fc
          WHERE fc.einkauf_id = e.id OR (fc.bank_tx_id IS NOT NULL AND fc.bank_tx_id = e.bank_tx_id)
        )
    `;
    // "Beleg fehlt": money that left the account with NO receipt — bank debits not tied to a
    // receipt and not a fixed cost. Real variable spend the user simply hasn't scanned, so it
    // belongs in the total; tapping the bucket lists these debits to generate/attach a receipt.
    // (Transfers modelled as fixed costs are excluded via their fixed_cost_check bank link.)
    const [recMissing] = await sql`
      SELECT COALESCE(SUM(ABS(bt.amount)), 0)::float8 AS total, COUNT(*)::int AS n
      FROM bank_tx bt
      WHERE bt.amount < 0
        AND bt.booking_date BETWEEN ${b.first} AND ${b.last}
        ${kIds && kIds.length ? sql`AND bt.konto_id = ANY(${kIds})` : sql``}
        AND NOT EXISTS (SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bt.id OR bt.einkauf_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM fixed_cost_check fc WHERE fc.bank_tx_id = bt.id)
    `;
    const receiptSpend = (receiptRow?.total as number) ?? 0;
    const receiptMissingAmt = (recMissing?.total as number) ?? 0;

    // Map a plan row (expense or income) to its month-view shape (check + suggestion).
    const mapPlan = (f: typeof fixed[number]) => ({
      id: f.id, label: f.label, monthly_eur: f.monthly_eur, kind: f.kind, frequency: f.frequency, is_transfer: f.is_transfer, expect_receipt: f.expect_receipt,
      one_off: f.one_off === true, counterpart_id: f.counterpart_id,
      match_merchant: f.match_merchant, konto_id: f.konto_id, konto_name: f.konto_name,
      is_shared: f.is_shared, owner: f.owner,
      complete: isComplete(f),
      bank_linked: f.check_bank_tx_id != null || f.ce_bank != null || f.ice_bank != null,
      check: f.check_id ? {
        status: f.check_status, source: f.check_source, einkauf_id: f.check_einkauf_id, bank_tx_id: f.check_bank_tx_id, income_id: f.check_income_id,
        amount: f.check_amount, laden: f.check_laden, datum: f.check_datum ? String(f.check_datum) : null,
      } : null,
      suggestion: sugByFixed.has(f.id as number) ? (() => {
        const s = sugByFixed.get(f.id as number)!;
        return { source: s.source, einkauf_id: s.einkaufId, bank_tx_id: s.bankTxId, income_id: s.incomeId, laden: s.laden, betrag: s.betrag, datum: s.datum, amount_ok: s.amountOk, merchant_ok: s.merchantOk };
      })() : null,
    });

    return {
      month: m,
      // recurring income PLANS (Einnahmen-Soll), matched vs actual income/bank credits.
      // (The raw actual-income rows are consumed only as evidence candidates above;
      // the month view sums the PLANS, so they are not returned.)
      incomes: fixed.filter(f => f.kind === 'income').map(mapPlan),
      fixed: fixed.filter(f => f.kind !== 'income').map(mapPlan),
      budgets: budgets.map(bu => ({
        id: bu.id, label: bu.label, monthly_target: bu.monthly_target, konto_id: bu.konto_id,
        konto_name: bu.konto_name, is_shared: bu.is_shared, owner: bu.owner,
        categories: bu.categories,
        actual: Math.round(((actualBy.get(bu.id as number) ?? 0)) * 100) / 100,
        forecast: forecastBy.get(bu.id as number) ?? null,
      })),
      // The month's TRUE variable-cost total = every receipt line once (incl. uncategorised)
      // PLUS un-receipted bank debits. NOT the sum of the (possibly overlapping) budgets.
      variableTotal: Math.round((receiptSpend + receiptMissingAmt) * 100) / 100,
      // Breakdown buckets that partition the total (budgeted + these), each a tappable row:
      unbudgeted: Math.round(((unbudget?.actual as number) ?? 0) * 100) / 100,      // categorised, no budget
      categoryMissing: Math.round(((catMissing?.total as number) ?? 0) * 100) / 100, // priced but uncategorised
      receiptMissing: Math.round(receiptMissingAmt * 100) / 100,                     // bank debit, no receipt
      receiptMissingCount: (recMissing?.n as number) ?? 0,
    };
  });

  /** Full evidence chain behind a fixed-cost check for one month: the bank booking
   *  AND the receipt/e-mail (and income row), resolved in BOTH directions — the
   *  check may reference just one of them, but if that one is married to the other
   *  (einkauf.bank_tx_id / income.bank_tx_id) we surface both. Powers the clickable
   *  Fixkosten row so the user sees which of {Bank, Beleg} — or both — is attached. */
  app.get('/api/finances/fixed-cost/:id/evidence', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const month = (req.query as { month?: string }).month?.trim();
    const b = month ? monthBounds(month) : null;
    if (!b) return reply.code(400).send({ error: 'month (YYYY-MM) required' });
    const [f] = await sql`SELECT frequency FROM fixed_cost WHERE id = ${id}`;
    if (!f) return reply.code(404).send({ error: 'not found' });
    const checkMonth = anchorMonth(b.first, f.frequency as string | null);
    const [c] = await sql`SELECT einkauf_id, bank_tx_id, income_id, amount::float8 AS amount, status FROM fixed_cost_check WHERE fixed_cost_id = ${id} AND month = ${checkMonth}`;
    if (!c) return { status: null, amount: null, bank: null, receipt: null, income: null };
    let bankId = c.bank_tx_id as number | null;
    let einkaufId = c.einkauf_id as number | null;
    let incomeId = c.income_id as number | null;
    // reverse-resolve the missing legs through the marriage links
    if (bankId && !einkaufId) { const [e] = await sql`SELECT id FROM einkauf WHERE bank_tx_id = ${bankId} LIMIT 1`; einkaufId = (e?.id as number) ?? null; }
    if (bankId && !incomeId) { const [i] = await sql`SELECT id FROM income WHERE bank_tx_id = ${bankId} LIMIT 1`; incomeId = (i?.id as number) ?? null; }
    if (einkaufId && !bankId) { const [e] = await sql`SELECT bank_tx_id FROM einkauf WHERE id = ${einkaufId}`; bankId = (e?.bank_tx_id as number) ?? null; }
    if (incomeId && !bankId) { const [i] = await sql`SELECT bank_tx_id FROM income WHERE id = ${incomeId}`; bankId = (i?.bank_tx_id as number) ?? null; }
    const [rec] = einkaufId ? await sql`SELECT id, datum::text AS datum, roh_ladenname, gesamt_betrag::float8 AS betrag, quelle, private_for_user_id FROM einkauf WHERE id = ${einkaufId}` : [null];
    const [bt] = bankId ? await sql`SELECT id, booking_date::text AS datum, amount::float8 AS amount, counterparty FROM bank_tx WHERE id = ${bankId}` : [null];
    const [inc] = incomeId ? await sql`SELECT id, datum::text AS datum, description, amount::float8 AS amount, file_path, file_name FROM income WHERE id = ${incomeId}` : [null];
    // A private receipt masks its own text AND its bank booking's merchant text.
    const uid = req.user?.id ?? -1;
    const masked = !!rec && (rec.private_for_user_id as number | null) != null && (rec.private_for_user_id as number | null) !== uid && !req.user?.sees_all_konten;
    return {
      status: c.status, amount: c.amount,
      bank: bt ? { id: bt.id, datum: bt.datum, amount: bt.amount, counterparty: masked ? null : bt.counterparty, private: masked } : null,
      receipt: rec ? (masked
        ? { id: null, laden: null, datum: rec.datum, betrag: rec.betrag, quelle: rec.quelle, private: true }
        : { id: rec.id, laden: rec.roh_ladenname, datum: rec.datum, betrag: rec.betrag, quelle: rec.quelle, private: false }) : null,
      income: inc ? { id: inc.id, datum: inc.datum, description: inc.description, amount: inc.amount, has_file: inc.file_path != null, file_name: inc.file_name ?? null } : null,
    };
  });

  /** Detach ONE leg of a fixed-cost check's evidence for a month, from the clickable
   *  evidence modal. leg='receipt'/'income' clears that ref on the check; leg='bank'
   *  drops the bank either from the check directly, or (when it's only shown via the
   *  married receipt/income) unmarries it there. If the check ends up with no evidence
   *  left, the month is reopened (check deleted). Private receipts are owner-guarded. */
  app.post('/api/finances/fixed-cost/:id/evidence/unlink', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    const body = (req.body ?? {}) as { month?: string; leg?: string };
    const leg = body.leg;
    const b = monthBounds((body.month ?? '').trim());
    if (!id || !b) return reply.code(400).send({ error: 'id and month (YYYY-MM) required' });
    if (leg !== 'bank' && leg !== 'receipt' && leg !== 'income') return reply.code(400).send({ error: 'leg must be bank|receipt|income' });
    const [f] = await sql`SELECT frequency FROM fixed_cost WHERE id = ${id}`;
    if (!f) return reply.code(404).send({ error: 'not found' });
    const checkMonth = anchorMonth(b.first, f.frequency as string | null);
    const uid = req.user?.id ?? -1;
    const seesAll = !!req.user?.sees_all_konten;
    return await sql.begin(async tx => {
      const [c] = await tx`SELECT einkauf_id, bank_tx_id, income_id, status FROM fixed_cost_check WHERE fixed_cost_id = ${id} AND month = ${checkMonth} FOR UPDATE`;
      if (!c) { reply.code(404); return { error: 'no check for this month' }; }
      // Reverse-resolve the legs the SAME way the evidence GET does, so we detach the
      // exact thing the modal showed — whether it sits on the check or only surfaces
      // through a receipt/income ↔ bank marriage.
      let bankId = c.bank_tx_id as number | null;
      let einkaufId = c.einkauf_id as number | null;
      let incomeId = c.income_id as number | null;
      if (bankId && !einkaufId) { const [e] = await tx`SELECT id FROM einkauf WHERE bank_tx_id = ${bankId} LIMIT 1`; einkaufId = (e?.id as number) ?? null; }
      if (bankId && !incomeId) { const [i] = await tx`SELECT id FROM income WHERE bank_tx_id = ${bankId} LIMIT 1`; incomeId = (i?.id as number) ?? null; }
      if (einkaufId && !bankId) { const [e] = await tx`SELECT bank_tx_id FROM einkauf WHERE id = ${einkaufId}`; bankId = (e?.bank_tx_id as number) ?? null; }
      if (incomeId && !bankId) { const [i] = await tx`SELECT bank_tx_id FROM income WHERE id = ${incomeId}`; bankId = (i?.bank_tx_id as number) ?? null; }
      // A private receipt (on the check OR reverse-resolved) is owner/super-admin only.
      if (einkaufId != null) {
        const [e] = await tx`SELECT private_for_user_id AS priv FROM einkauf WHERE id = ${einkaufId}`;
        if (e && e.priv != null && e.priv !== uid && !seesAll) { reply.code(403); return { error: 'private receipt' }; }
      }
      // Keep the OTHER legs — promoting a married one onto the check so it survives —
      // and break the removed leg's marriage so it can't reverse-resolve back in.
      let keepEinkauf = einkaufId, keepIncome = incomeId, keepBank = bankId;
      const breakReceiptBank = async () => { if (einkaufId != null) { await tx`UPDATE bank_tx SET einkauf_id = NULL WHERE einkauf_id = ${einkaufId}`; await tx`UPDATE einkauf SET bank_tx_id = NULL WHERE id = ${einkaufId}`; } };
      const breakIncomeBank = async () => { if (incomeId != null) await tx`UPDATE income SET bank_tx_id = NULL WHERE id = ${incomeId}`; };
      if (leg === 'bank') { keepBank = null; await breakReceiptBank(); await breakIncomeBank(); }
      else if (leg === 'receipt') { keepEinkauf = null; await breakReceiptBank(); }
      else { keepIncome = null; await breakIncomeBank(); }
      await tx`UPDATE fixed_cost_check SET einkauf_id = ${keepEinkauf}, bank_tx_id = ${keepBank}, income_id = ${keepIncome} WHERE fixed_cost_id = ${id} AND month = ${checkMonth}`;
      // No evidence left → reopen the month (a deliberately skipped check stays).
      if (c.status !== 'skipped' && keepEinkauf == null && keepBank == null && keepIncome == null) {
        await tx`DELETE FROM fixed_cost_check WHERE fixed_cost_id = ${id} AND month = ${checkMonth}`;
      }
      return { ok: true };
    });
  });

  /** Decide a fixed-cost check for one month.
   *  action 'confirm' (+ optional einkauf_id as evidence), 'skip' ("this month is
   *  fine without evidence") or 'clear' (reopen). Confirming with a receipt LEARNS
   *  match_merchant from the receipt's store name when none is set yet. */
  app.post('/api/finances/check', async (req, reply) => {
    const bdy = (req.body ?? {}) as { fixed_cost_id?: number; month?: string; action?: string; einkauf_id?: number | null; bank_tx_id?: number | null; income_id?: number | null };
    const fixedId = parseInt(String(bdy.fixed_cost_id ?? ''), 10);
    const bounds = monthBounds((bdy.month ?? '').trim());
    if (!fixedId || !bounds) return reply.code(400).send({ error: 'fixed_cost_id and month (YYYY-MM) required' });
    const [f] = await sql`SELECT id, match_merchant, frequency FROM fixed_cost WHERE id = ${fixedId}`;
    if (!f) return reply.code(404).send({ error: 'fixed cost not found' });
    // Quarterly/yearly costs share one check per period (anchored to its first
    // month), so a single invoice covers every month of the quarter/year.
    const checkMonth = anchorMonth(bounds.first, f.frequency as string | null);

    if (bdy.action === 'clear') {
      await sql`DELETE FROM fixed_cost_check WHERE fixed_cost_id = ${fixedId} AND month = ${checkMonth}`;
      return { ok: true };
    }
    if (bdy.action !== 'confirm' && bdy.action !== 'skip') return reply.code(400).send({ error: 'bad action' });

    let einkaufId: number | null = null;
    let bankTxId: number | null = null;
    let bankKonto: number | null = null;
    let incomeId: number | null = null;
    let amount: number | null = null;
    // A confirm may carry a DOCUMENT (invoice / pay slip) AND the bank STATEMENT (the
    // actual payment) at once, so a fixed cost is fully reconciled in one step — both
    // land on the same fixed_cost_check row. The document amount is authoritative;
    // the bank amount is only a fallback. Merchant is learned from the document first.
    if (bdy.action === 'confirm') {
      let learnMerchant: string | null = null;
      if (bdy.income_id) {
        const [inc] = await sql`SELECT id, amount::float8 AS amount, description FROM income WHERE id = ${bdy.income_id}`;
        if (!inc) return reply.code(404).send({ error: 'income not found' });
        incomeId = inc.id as number;
        amount = inc.amount as number | null;
        learnMerchant = ((inc.description as string | null) ?? '').trim() || learnMerchant;
      }
      if (bdy.einkauf_id) {
        const [e] = await sql`
          SELECT e.id, e.gesamt_betrag::float8 AS betrag, e.roh_ladenname, e.quelle FROM einkauf e
          WHERE e.id = ${bdy.einkauf_id} ${kontoScope(req.user, sql`e`)}`;
        if (!e) return reply.code(404).send({ error: 'receipt not found' });
        // Guard: a fixed cost can only be backed by an invoice (e-mail or dropped
        // PDF), never a till/cash receipt — even if the client somehow passes one.
        if (e.quelle !== 'email' && e.quelle !== 'upload') return reply.code(400).send({ error: 'fixed costs can only be matched to invoices, not till receipts' });
        einkaufId = e.id as number;
        amount = e.betrag as number | null;
        learnMerchant = ((e.roh_ladenname as string | null) ?? '').trim() || learnMerchant;
      }
      if (bdy.bank_tx_id) {
        const [bt] = await sql`SELECT id, amount::float8 AS amount, counterparty, description, konto_id FROM bank_tx WHERE id = ${bdy.bank_tx_id}`;
        if (!bt) return reply.code(404).send({ error: 'bank transaction not found' });
        bankTxId = bt.id as number;
        bankKonto = (bt.konto_id as number | null) ?? null;
        if (amount == null) amount = Math.abs(bt.amount as number);
        if (!learnMerchant) learnMerchant = ((bt.counterparty as string | null) ?? '').trim() || ((bt.description as string | null) ?? '').trim();
      }
      // Learn the merchant for future auto-suggestions ("Internet" ↔ "Telekom").
      if (learnMerchant && !f.match_merchant) await sql`UPDATE fixed_cost SET match_merchant = ${learnMerchant} WHERE id = ${fixedId}`;
    }
    await sql`
      INSERT INTO fixed_cost_check (fixed_cost_id, month, status, einkauf_id, bank_tx_id, income_id, amount, decided_by)
      VALUES (${fixedId}, ${checkMonth}, ${bdy.action === 'skip' ? 'skipped' : 'confirmed'}, ${einkaufId}, ${bankTxId}, ${incomeId}, ${amount}, ${req.user?.id ?? null})
      ON CONFLICT (fixed_cost_id, month) DO UPDATE SET
        status = EXCLUDED.status, einkauf_id = EXCLUDED.einkauf_id, bank_tx_id = EXCLUDED.bank_tx_id,
        income_id = EXCLUDED.income_id, amount = EXCLUDED.amount, decided_by = EXCLUDED.decided_by, decided_at = NOW()`;
    // Reconciling a fixed cost with BOTH an invoice and a bank statement: marry them (so the
    // receipt itself shows the payment) and move the invoice onto the account that paid it +
    // learn biller -> account. (The UI confirms any account move before sending this.)
    if (einkaufId != null && bankTxId != null) await alignInvoiceToBank(einkaufId, bankTxId, bankKonto);
    return { ok: true };
  });

  // ── Income (pay-slip upload → income row) ─────────────────────────────────

  /** List income entries, newest first. With ?month=YYYY-MM → that month only;
   *  without → all entries (the Verwaltung "Einnahmen" ledger). owner_name = the
   *  household member linked to the account (falls back to username on the client). */
  app.get('/api/finances/income', async (req, reply) => {
    const raw = ((req.query as { month?: string }).month ?? '').trim();
    const b = raw ? monthBounds(raw) : null;
    if (raw && !b) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    const rows = await sql`
      SELECT i.id, i.datum::text AS datum, i.amount::float8 AS amount, i.source, i.description,
             i.konto_id, k.name AS konto_name, k.is_shared, u.username AS owner,
             (SELECT fm.name FROM family_member fm WHERE fm.user_id = k.user_id ORDER BY fm.sort_order, fm.id LIMIT 1) AS owner_name,
             (i.file_path IS NOT NULL) AS has_file, i.file_name,
             i.bank_tx_id, bt.booking_date::text AS bank_booking, bt.amount::float8 AS bank_amount, bt.counterparty AS bank_counterparty
      FROM income i
      LEFT JOIN konto k ON k.id = i.konto_id
      LEFT JOIN users u ON u.id = k.user_id
      LEFT JOIN bank_tx bt ON bt.id = i.bank_tx_id
      ${b ? sql`WHERE i.datum BETWEEN ${b.first} AND ${b.last}` : sql``}
      ORDER BY i.datum DESC, i.id DESC`;
    return {
      income: rows.map(r => ({
        ...r,
        bank: r.bank_tx_id ? { id: r.bank_tx_id, booking_date: r.bank_booking, amount: r.bank_amount, counterparty: r.bank_counterparty } : null,
      })),
    };
  });

  /** Income-evidence candidates of a month for the manual picker on an income plan:
   *  actual income rows (pay slips) + bank credits (Gutschriften, amount > 0). */
  app.get('/api/finances/income-evidence', async (req, reply) => {
    const query = req.query as { month?: string; freq?: string };
    const b = monthBounds((query.month ?? '').trim());
    if (!b) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    // Income keeps the tight period bounds (no bank booking-lag) so a MONTHLY income plan is
    // unchanged from before; a periodic income plan (rare) still spans its quarter/year.
    const p = periodBounds(b, query.freq);
    const inc = await sql`SELECT id, datum::text AS datum, amount::float8 AS amount, description FROM income WHERE datum BETWEEN ${p.lo} AND ${p.hi} ORDER BY datum DESC, id DESC`;
    const bank = await sql`SELECT id, booking_date::text AS datum, amount::float8 AS amount, counterparty, description FROM bank_tx WHERE booking_date BETWEEN ${p.lo} AND ${p.hi} AND amount > 0 ORDER BY booking_date DESC`;
    return {
      items: [
        ...inc.map(i => ({ source: 'income' as const, id: i.id, datum: String(i.datum), amount: i.amount, label: (i.description as string | null) || 'Einnahme' })),
        ...bank.map(bt => ({ source: 'bank' as const, id: bt.id, datum: String(bt.datum), amount: bt.amount, label: [bt.counterparty, bt.description].filter(Boolean).join(' ') || 'Gutschrift' })),
      ],
    };
  });

  /** Expense-evidence candidates for the manual picker on a fixed-cost (expense) plan:
   *  invoices of the month (e-mail/upload) + bank DEBITS in a WIDE window. The window
   *  spills a few days into the neighbouring months because bank bookings lag — e.g. a
   *  loan installment due end-of-month often books on the 1st of the next month. */
  app.get('/api/finances/expense-evidence', async (req, reply) => {
    const query = req.query as { month?: string; freq?: string };
    const b = monthBounds((query.month ?? '').trim());
    if (!b) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    // A quarterly/yearly plan's single payment can land in any month of its period, so widen
    // the candidate window to the whole quarter/year; the bank window keeps the ±booking-lag
    // so an end-of-period charge that books a few days later is still offered.
    const p = periodBounds(b, query.freq);
    const bankLo = isoMinusDays(p.lo, 7), bankHi = isoPlusDays(p.hi, 12);
    const rec = await sql`
      SELECT e.id, e.datum::text AS datum, e.gesamt_betrag::float8 AS amount, e.roh_ladenname, e.konto_id, k.name AS konto_name
      FROM einkauf e LEFT JOIN konto k ON k.id = e.konto_id
      WHERE e.datum BETWEEN ${p.lo} AND ${p.hi} AND e.gesamt_betrag IS NOT NULL
        AND e.quelle IN ('email', 'upload')
        ${kontoScope(req.user, sql`e`)}
      ORDER BY e.datum DESC`;
    const bank = await sql`
      SELECT bank_tx.id, booking_date::text AS datum, amount::float8 AS amount, counterparty, konto_id,
             (SELECT name FROM konto WHERE id = bank_tx.konto_id) AS konto_name,
             -- the receipt this debit is already the payment of, if any (either link direction)
             COALESCE(einkauf_id, (SELECT e.id FROM einkauf e WHERE e.bank_tx_id = bank_tx.id LIMIT 1)) AS linked_einkauf_id
      FROM bank_tx WHERE booking_date BETWEEN ${bankLo} AND ${bankHi} AND amount < 0
      -- OPEN debits first; the linked ones are still returned so the picker can show them
      -- greyed-out (transparency), but they are not selectable there. (Repeat the openness
      -- expression here — a SELECT alias isn't visible inside an ORDER BY expression.)
      ORDER BY (einkauf_id IS NULL AND NOT EXISTS (SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bank_tx.id)) DESC, booking_date DESC`;
    return {
      items: [
        ...rec.map(r => ({ source: 'receipt' as const, id: r.id, datum: String(r.datum), amount: r.amount, label: (r.roh_ladenname as string | null) || 'Beleg', linked_einkauf_id: null as number | null, konto_id: (r.konto_id as number | null) ?? null, konto_name: (r.konto_name as string | null) ?? null })),
        ...bank.map(bt => ({ source: 'bank' as const, id: bt.id, datum: String(bt.datum), amount: Math.abs(bt.amount as number), label: (bt.counterparty as string | null) || 'Kontobewegung', linked_einkauf_id: (bt.linked_einkauf_id as number | null) ?? null, konto_id: (bt.konto_id as number | null) ?? null, konto_name: (bt.konto_name as string | null) ?? null })),
      ],
    };
  });

  /** Upload a pay slip (DATEV etc.) as base64 → extract salary via Vision → create
   *  an income row (source='salary', amount = Auszahlungsbetrag/net). The client
   *  sends one file per request (so several PDFs upload sequentially). */
  app.post('/api/finances/income/upload', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const bdy = (req.body ?? {}) as { filename?: string; data_b64?: string; konto_id?: number };
    const kontoId = parseInt(String(bdy.konto_id ?? ''), 10);
    if (!kontoId) return reply.code(400).send({ error: 'konto_id required' });
    if (!bdy.data_b64) return reply.code(400).send({ error: 'data_b64 required' });
    // Every account is visible to every user (finances are shared); just require
    // a real non-cash account (cash accounts don't carry a salary).
    const [k] = await sql`SELECT id FROM konto WHERE id = ${kontoId} AND is_cash = FALSE`;
    if (!k) return reply.code(404).send({ error: 'account not found' });

    let buf: Buffer;
    try { buf = Buffer.from(bdy.data_b64.replace(/^data:[^,]*,/, ''), 'base64'); }
    catch { return reply.code(400).send({ error: 'bad base64' }); }
    if (!buf.length) return reply.code(400).send({ error: 'empty file' });

    let ex;
    try { ex = await extractPayslip(buf); }
    catch (e) { return reply.code(502).send({ error: (e as Error).message.slice(0, 300) }); }

    // Not a readable pay slip → report back, create nothing.
    if ((ex.confidence ?? 0) < 0.3 || ex.netto == null || !(ex.netto > 0)) {
      return { ok: false, filename: bdy.filename ?? null, extracted: ex, reason: 'no readable pay-slip data (net amount not found)' };
    }
    const datum = /^\d{4}-\d{2}$/.test(ex.monat ?? '') ? `${ex.monat}-01` : new Date().toISOString().slice(0, 10);
    const descr = [ex.arbeitgeber?.trim() || 'Gehalt', ex.brutto != null ? `Brutto ${ex.brutto.toFixed(2)} €` : null]
      .filter(Boolean).join(' · ');
    const [row] = await sql`
      INSERT INTO income (datum, amount, category_path, konto_id, source, description, created_by)
      VALUES (${datum}::date, ${ex.netto}, 'Gehalt', ${kontoId}, 'salary', ${descr}, ${req.user?.id ?? null})
      RETURNING id`;
    // Persist the uploaded file so it can be viewed later. Best-effort: if the disk
    // write fails the income row still stands (just without a viewable document).
    const origName = (bdy.filename ?? '').toString();
    const ext = (origName.match(/\.(pdf|png|jpe?g|webp|heic)$/i)?.[0] ?? '.pdf').toLowerCase();
    const stored = `${row.id}_${randomBytes(6).toString('hex')}${ext}`;
    try {
      await mkdir(PAYSLIP_DIR, { recursive: true });
      await writeFile(path.join(PAYSLIP_DIR, stored), buf);
      await sql`UPDATE income SET file_path = ${stored}, file_name = ${origName || `gehaltszettel${ext}`} WHERE id = ${row.id}`;
    } catch (e) { req.log.warn(`payslip file store failed: ${(e as Error).message}`); }
    return {
      ok: true, income_id: row.id, filename: bdy.filename ?? null,
      datum, netto: ex.netto, brutto: ex.brutto, monat: ex.monat, arbeitgeber: ex.arbeitgeber,
    };
  });

  /** Attach a file to an EXISTING income row (no new row, no re-extraction) — used to
   *  backfill pay-slip PDFs for entries imported before file storage existed, so a
   *  HICO income entry has both its bank credit AND its pay-slip. Replaces any prior file. */
  app.post('/api/finances/income/:id/file', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const bdy = (req.body ?? {}) as { filename?: string; data_b64?: string };
    if (!bdy.data_b64) return reply.code(400).send({ error: 'data_b64 required' });
    const [row] = await sql`SELECT id FROM income WHERE id = ${id}`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    let buf: Buffer;
    try { buf = Buffer.from(bdy.data_b64.replace(/^data:[^,]*,/, ''), 'base64'); }
    catch { return reply.code(400).send({ error: 'bad base64' }); }
    if (!buf.length) return reply.code(400).send({ error: 'empty file' });
    const origName = (bdy.filename ?? '').toString();
    const ext = (origName.match(/\.(pdf|png|jpe?g|webp|heic)$/i)?.[0] ?? '.pdf').toLowerCase();
    const stored = `${id}_${randomBytes(6).toString('hex')}${ext}`;
    await mkdir(PAYSLIP_DIR, { recursive: true });
    await writeFile(path.join(PAYSLIP_DIR, stored), buf);
    await sql`UPDATE income SET file_path = ${stored}, file_name = ${origName || `gehaltszettel${ext}`} WHERE id = ${id}`;
    return { ok: true };
  });

  /** Stream a stored pay-slip file (auth-guarded; income is shared household data).
   *  basename() guards path traversal; only files inside PAYSLIP_DIR are reachable. */
  app.get('/api/finances/income/:id/file', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const [row] = await sql`SELECT file_path, file_name FROM income WHERE id = ${id}`;
    if (!row?.file_path) return reply.code(404).send({ error: 'no file' });
    const full = path.join(PAYSLIP_DIR, path.basename(row.file_path as string));
    if (!existsSync(full)) return reply.code(404).send({ error: 'file missing' });
    const buf = await readFile(full);
    const dispName = ((row.file_name as string | null) ?? 'gehaltszettel').replace(/[^\w.\-]/g, '_');
    void reply.header('Content-Disposition', `inline; filename="${dispName}"`);
    void reply.type(MIME_BY_EXT[path.extname(full).toLowerCase()] ?? 'application/octet-stream');
    return reply.send(buf);
  });

  /** Delete an income entry (e.g. a mis-read pay slip). Konto-scoped. */
  app.delete('/api/finances/income/:id', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const [row] = await sql`SELECT id FROM income WHERE id = ${id}`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    await sql`DELETE FROM income WHERE id = ${id}`;
    return { ok: true };
  });

  // ── Bank statement import (comdirect CSV → bank_tx) ───────────────────────

  const isoMinusDays = (iso: string, n: number): string => {
    const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const isoPlusDays = (iso: string, n: number): string => {
    const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // The period a plan's evidence may fall in: its whole quarter/year for a periodic plan
  // (its one payment lands in a single month of the period), else just the viewed month.
  const periodBounds = (b: { first: string; last: string }, freq: string | undefined): { lo: string; hi: string } => {
    const y = b.first.slice(0, 4), mo = Number(b.first.slice(5, 7));
    if (freq === 'yearly') return { lo: `${y}-01-01`, hi: `${y}-12-31` };
    if (freq === 'quarterly') {
      const qs = Math.floor((mo - 1) / 3) * 3 + 1;
      return { lo: `${y}-${String(qs).padStart(2, '0')}-01`, hi: new Date(Date.UTC(Number(y), qs - 1 + 3, 0)).toISOString().slice(0, 10) };
    }
    return { lo: b.first, hi: b.last };
  };

  /** Auto-link by ORDER NUMBER — the strongest signal, immune to the date window.
   *  Amazon (and similar) put the order number in the booking text ("304-8531658-…")
   *  and the same number appears in the e-mail receipt's body/subject, so a pre-order
   *  whose invoice is months before the charge still matches 1:1. Requires the amount
   *  to still fit (guards partial shipments) and a UNIQUE receipt for that order. */
  const ORDER_RE = /\d{3}-\d{7}-\d{7}/g; // JS \d (Postgres POSIX ~ would need [0-9])
  const autoMatchBankByOrder = async (kontoId?: number | null): Promise<number> => {
    const debits = await sql`
      SELECT id, amount::float8 AS amount, description, raw, counterparty
      FROM bank_tx bt
      WHERE bt.amount < 0 AND bt.einkauf_id IS NULL AND NOT EXISTS (SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bt.id)
        ${kontoId ? sql`AND bt.konto_id = ${kontoId}` : sql``}`;
    let linked = 0;
    for (const d of debits) {
      const text = `${(d.description as string | null) ?? ''}\n${(d.raw as string | null) ?? ''}\n${(d.counterparty as string | null) ?? ''}`;
      const orders = [...new Set(text.match(ORDER_RE) ?? [])];
      if (!orders.length) continue;
      const target = Math.abs(d.amount as number);
      const tol = Math.max(1, target * 0.05);
      for (const ord of orders) {
        const like = `%${ord}%`;
        const cands = await sql`
          SELECT e.id, e.gesamt_betrag::float8 AS betrag
          FROM einkauf e JOIN email_message em ON em.einkauf_id = e.id
          WHERE e.bank_tx_id IS NULL AND e.gesamt_betrag IS NOT NULL
            AND (em.body_text ILIKE ${like} OR em.html ILIKE ${like} OR em.subject ILIKE ${like})`;
        const m = cands.filter(c => Math.abs((c.betrag as number) - target) <= tol);
        if (m.length === 1) { await sql`UPDATE einkauf SET bank_tx_id = ${d.id} WHERE id = ${m[0].id}`; linked++; break; }
      }
    }
    return linked;
  };

  /** Split-shipment matcher: Amazon (and similar) charge ONE order/invoice as SEVERAL
   *  bank debits (per parcel) that together SUM to the invoice total. Group the open
   *  debits whose order numbers appear in an unlinked receipt's e-mail, and if they
   *  sum to that receipt's total (±1.5 %), link the whole group to it — the first debit
   *  as the primary (einkauf.bank_tx_id), every debit via bank_tx.einkauf_id. Runs
   *  after the single-debit order matcher, so 1:1 orders are already taken. Returns the
   *  number of DEBITS newly linked. */
  const autoMatchBankByOrderSum = async (kontoId?: number | null): Promise<number> => {
    const debits = await sql`
      SELECT id, amount::float8 AS amount, description, raw, counterparty
      FROM bank_tx bt
      WHERE bt.amount < 0 AND bt.einkauf_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bt.id)
        ${kontoId ? sql`AND bt.konto_id = ${kontoId}` : sql``}`;
    const debitOrders = new Map<number, { amount: number; orders: Set<string> }>();
    for (const d of debits) {
      const text = `${(d.description as string | null) ?? ''}\n${(d.raw as string | null) ?? ''}\n${(d.counterparty as string | null) ?? ''}`;
      const orders = new Set(text.match(ORDER_RE) ?? []);
      if (orders.size) debitOrders.set(d.id as number, { amount: Math.abs(d.amount as number), orders });
    }
    if (!debitOrders.size) return 0;
    // Unlinked receipts that carry an e-mail (invoice), biggest total first (greedy:
    // a multi-order e-mail claims all its debits before a smaller overlapping one).
    const emails = await sql`
      SELECT e.id, e.gesamt_betrag::float8 AS total,
             coalesce(em.subject,'') || ' ' || coalesce(em.body_text,'') || ' ' || coalesce(em.html,'') AS t
      FROM einkauf e JOIN email_message em ON em.einkauf_id = e.id
      WHERE e.bank_tx_id IS NULL AND e.gesamt_betrag IS NOT NULL
      ORDER BY e.gesamt_betrag DESC, e.id`;
    // How many unlinked receipts own each order number: only order numbers unique to a
    // single receipt are safe to auto-group on. If the same order appears in two
    // unlinked receipts (e.g. a duplicate e-mail import), it's ambiguous → left for the
    // manual picker, mirroring the single-debit matcher's "exactly one candidate" rule.
    const emailList = emails.map(em => ({ id: em.id as number, total: em.total as number, orders: new Set(String(em.t).match(ORDER_RE) ?? []) }));
    const orderOwners = new Map<string, Set<number>>();
    for (const em of emailList) for (const o of em.orders) { if (!orderOwners.has(o)) orderOwners.set(o, new Set()); orderOwners.get(o)!.add(em.id); }
    const used = new Set<number>();
    let linkedDebits = 0;
    for (const em of emailList) {
      if (!em.orders.size) continue;
      const group: { id: number; amount: number }[] = [];
      for (const [id, d] of debitOrders) {
        if (used.has(id)) continue;
        // Include the debit only if it shares an order that belongs to THIS receipt ALONE.
        let ok = false;
        for (const o of d.orders) { if (em.orders.has(o) && (orderOwners.get(o)?.size ?? 0) === 1) { ok = true; break; } }
        if (ok) group.push({ id, amount: d.amount });
      }
      if (group.length < 2) continue;                 // a genuine split has ≥2 debits; singles are autoMatchBankByOrder's job
      const total = em.total;
      const sum = group.reduce((a, g) => a + g.amount, 0);
      if (Math.abs(sum - total) > Math.max(1, total * 0.015)) continue; // not the full set → leave for manual
      group.sort((a, b) => a.id - b.id);
      await sql`UPDATE einkauf SET bank_tx_id = ${group[0].id} WHERE id = ${em.id} AND bank_tx_id IS NULL`;
      for (const g of group) { await sql`UPDATE bank_tx SET einkauf_id = ${em.id} WHERE id = ${g.id}`; used.add(g.id); }
      linkedDebits += group.length;
    }
    return linkedDebits;
  };

  /** LATE-PARCEL matcher: the split-shipment case where the parcels arrive in DIFFERENT
   *  imports. The matchers above all require an UNLINKED receipt (e.bank_tx_id IS NULL),
   *  so once the first parcel claimed the invoice, a parcel booked later (next month's
   *  CSV) finds no candidate and stays open forever — and its amount is only a FRACTION
   *  of the invoice total, so the amount matcher below can never catch it either.
   *  Here we go the other way round: for an open debit carrying an order number, find the
   *  ONE receipt whose e-mail owns that order and still has uncovered value, then attach
   *  the debit as a SIBLING (bank_tx.einkauf_id) — the invoice keeps its primary. Safe
   *  because: the order number is near-certain and date-immune, it must be unique to a
   *  single receipt (same rule as above), and the parcel may never overshoot what the
   *  invoice still owes. A receipt with no primary yet adopts this debit as its primary,
   *  so we never leave siblings without one (the delete path relies on that). */
  const autoMatchBankByOrderSibling = async (kontoId?: number | null): Promise<number> => {
    const debits = await sql`
      SELECT id, amount::float8 AS amount, description, raw, counterparty
      FROM bank_tx bt
      WHERE bt.amount < 0 AND bt.einkauf_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bt.id)
        ${kontoId ? sql`AND bt.konto_id = ${kontoId}` : sql``}
      ORDER BY bt.booking_date, bt.id`;
    let linked = 0;
    for (const d of debits) {
      const text = `${(d.description as string | null) ?? ''}\n${(d.raw as string | null) ?? ''}\n${(d.counterparty as string | null) ?? ''}`;
      const orders = [...new Set(text.match(ORDER_RE) ?? [])];
      if (!orders.length) continue;
      const amount = Math.abs(d.amount as number);
      // Resolve EVERY order the text names BEFORE linking anything. Amazon can bill several
      // orders as a single debit, and then there is no way to tell how much of it belongs to
      // which invoice — so a debit only counts as unambiguous when every order it names
      // resolves to the SAME single receipt. An order owned by two receipts (duplicate e-mail
      // import), an unknown order next to a known one, or two different receipts named at
      // once all go to the manual picker instead of being silently booked against the first.
      let target: { id: number; bank_tx_id: number | null; remaining: number } | null = null;
      let ambiguous = false;
      for (const ord of orders) {
        const like = `%${ord}%`;
        // Receipts whose e-mail carries this order, with the value still uncovered by the
        // statements already attached (either link direction — the OR can't double-count a
        // row that is both primary and sibling). Same expression as /candidates.
        const cands = await sql`
          SELECT e.id, e.bank_tx_id,
                 (e.gesamt_betrag - COALESCE((SELECT SUM(ABS(bt2.amount)) FROM bank_tx bt2
                    WHERE bt2.einkauf_id = e.id OR bt2.id = e.bank_tx_id), 0))::float8 AS remaining
          FROM einkauf e JOIN email_message em ON em.einkauf_id = e.id
          WHERE e.gesamt_betrag IS NOT NULL
            AND (em.body_text ILIKE ${like} OR em.html ILIKE ${like} OR em.subject ILIKE ${like})`;
        if (cands.length !== 1) { ambiguous = true; break; }
        const c = { id: cands[0].id as number, bank_tx_id: (cands[0].bank_tx_id as number | null) ?? null, remaining: cands[0].remaining as number };
        if (target && target.id !== c.id) { ambiguous = true; break; }
        target = c;
      }
      if (ambiguous || !target) continue;
      // The invoice must still owe something, and the parcel must fit in what is owed. The
      // tolerance stays tight ON PURPOSE: a slack as big as the parcel itself would let a
      // FULLY paid invoice swallow a small debit (remaining 0 vs a 0.50 charge).
      if (target.remaining <= 0.005) continue;
      if (amount - target.remaining > Math.max(0.02, target.remaining * 0.015)) continue;
      const linkedNow = await sql`UPDATE bank_tx SET einkauf_id = ${target.id} WHERE id = ${d.id} AND einkauf_id IS NULL RETURNING id`;
      if (!linkedNow.length) continue;
      // No primary yet (every parcel arrived late) → this debit becomes it, so a receipt
      // never ends up with siblings but no primary (the delete path relies on that).
      if (target.bank_tx_id == null) await sql`UPDATE einkauf SET bank_tx_id = ${d.id} WHERE id = ${target.id} AND bank_tx_id IS NULL`;
      linked++;
    }
    return linked;
  };

  /** Auto-link bank debits to scanned receipts. A match needs the exact amount, a
   *  shared merchant token AND a date window: the booking lags a few days behind the
   *  purchase, so the receipt must fall on/before the booking day (≤10 days back) or
   *  within ±2 days of the embedded card-purchase date. Only UNAMBIGUOUS matches
   *  (exactly one candidate) are auto-linked; ambiguous ones wait for the picker. */
  const autoMatchBank = async (kontoId?: number | null): Promise<number> => {
    const debits = await sql`
      SELECT bt.id, bt.konto_id, bt.amount::float8 AS amount, bt.counterparty,
             bt.booking_date::text AS booking, bt.purchase_date::text AS purchase
      FROM bank_tx bt
      WHERE bt.amount < 0
        AND bt.einkauf_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bt.id)
        ${kontoId ? sql`AND bt.konto_id = ${kontoId}` : sql``}
      ORDER BY bt.booking_date, bt.id`;
    if (!debits.length) return 0;
    const receipts = await sql`
      SELECT e.id, e.konto_id, e.gesamt_betrag::float8 AS betrag, e.roh_ladenname, e.datum::text AS datum
      FROM einkauf e WHERE e.bank_tx_id IS NULL AND e.gesamt_betrag IS NOT NULL`;
    const used = new Set<number>();
    let linked = 0;
    for (const d of debits) {
      const target = Math.abs(d.amount as number);
      const bankToks = normMerchant((d.counterparty as string | null) ?? '').split(' ').filter(w => w.length >= 4);
      if (!bankToks.length) continue;
      const booking = String(d.booking);
      const purchase = d.purchase ? String(d.purchase) : null;
      const lo = purchase ? isoMinusDays(purchase, 2) : isoMinusDays(booking, 10);
      const hi = purchase ? isoPlusDays(purchase, 2) : booking;
      // The TRUE candidate set (amount + date window + merchant) — NOT shrunk by
      // `used`, so the ambiguity check below is honest. Prefer same-konto receipts
      // (a card payment's receipt belongs on that account); only fall back to other
      // konten if this account has none, which avoids cross-account mislinks.
      const all = receipts.filter(r => {
        if (Math.abs((r.betrag as number) - target) >= 0.005) return false;
        const rd = String(r.datum);
        if (rd < lo || rd > hi) return false;
        const recNorm = normMerchant((r.roh_ladenname as string | null) ?? '');
        return bankToks.some(tk => recNorm.includes(tk));
      });
      // Auto-link ONLY when unambiguous: exactly one candidate on the bank_tx's own
      // account with NO competitor elsewhere, or (receipt scanned to the "wrong"
      // account) exactly one anywhere with none on this account. Any competition —
      // including one same-konto + one other-konto — is left for the manual picker,
      // so the same-konto tiebreak can never silently paper over a real ambiguity.
      const same = all.filter(r => r.konto_id === d.konto_id);
      const other = all.filter(r => r.konto_id !== d.konto_id);
      const pick = same.length === 1 && other.length === 0 ? same[0]
        : same.length === 0 && other.length === 1 ? other[0] : null;
      if (pick && !used.has(pick.id as number)) {
        await sql`UPDATE einkauf SET bank_tx_id = ${d.id} WHERE id = ${pick.id}`;
        used.add(pick.id as number);
        linked++;
      }
    }
    return linked;
  };

  /** Auto-link bank GUTSCHRIFTEN (credits) to actual income rows — the mirror of the
   *  debit↔receipt matcher. Income rows (pay slips) are dated month-01 while the bank
   *  books the pay day mid/end month, so the date window is wide (income −45..+10 of
   *  booking). Same amount + shared token + unambiguous + same-konto preference. */
  const autoMatchBankCredits = async (kontoId?: number | null): Promise<number> => {
    const credits = await sql`
      SELECT bt.id, bt.konto_id, bt.amount::float8 AS amount, bt.counterparty, bt.booking_date::text AS booking
      FROM bank_tx bt
      WHERE bt.amount > 0
        AND NOT EXISTS (SELECT 1 FROM income i WHERE i.bank_tx_id = bt.id)
        ${kontoId ? sql`AND bt.konto_id = ${kontoId}` : sql``}
      ORDER BY bt.booking_date, bt.id`;
    if (!credits.length) return 0;
    const incomes = await sql`
      SELECT i.id, i.konto_id, i.amount::float8 AS amount, i.description, i.datum::text AS datum
      FROM income i WHERE i.bank_tx_id IS NULL`;
    const used = new Set<number>();
    let linked = 0;
    for (const c of credits) {
      const target = c.amount as number;
      const toks = normMerchant((c.counterparty as string | null) ?? '').split(' ').filter(w => w.length >= 4);
      if (!toks.length) continue;
      const booking = String(c.booking);
      const lo = isoMinusDays(booking, 45);
      const hi = isoPlusDays(booking, 10);
      const all = incomes.filter(i => {
        if (Math.abs((i.amount as number) - target) >= 0.005) return false;
        const d = String(i.datum);
        if (d < lo || d > hi) return false;
        const rn = normMerchant((i.description as string | null) ?? '');
        return toks.some(tk => rn.includes(tk));
      });
      // Same unambiguous rule as the debit matcher: exactly one same-konto candidate
      // with no competitor elsewhere, or exactly one anywhere with none same-konto.
      // The wide credit window over constant monthly salary makes a same-konto tiebreak
      // over a genuine cross-month/-konto ambiguity dangerous, so we never take it.
      const same = all.filter(i => i.konto_id === c.konto_id);
      const other = all.filter(i => i.konto_id !== c.konto_id);
      const pick = same.length === 1 && other.length === 0 ? same[0]
        : same.length === 0 && other.length === 1 ? other[0] : null;
      if (pick && !used.has(pick.id as number)) {
        await sql`UPDATE income SET bank_tx_id = ${c.id} WHERE id = ${pick.id}`;
        used.add(pick.id as number);
        linked++;
      }
    }
    return linked;
  };

  /** Creative AI second pass: for bank lines the deterministic matcher left open,
   *  ask the configured LLM to propose a match — but ONLY among candidates we
   *  pre-filtered by amount+date (so it decides, never scans blindly), and we accept
   *  a proposal ONLY if its (kind,id) was actually in the set we offered (anti-
   *  hallucination) AND confidence ≥ 0.75. Proposals are stored as SUGGESTIONS
   *  (⭐, human-approved) — never auto-linked. Bounded to keep prompt + cost small. */
  const aiMatchBank = async (kontoId?: number | null): Promise<number> => {
    const open = await sql`
      SELECT bt.id, bt.konto_id, bt.amount::float8 AS amount, bt.counterparty, bt.description,
             bt.booking_date::text AS booking, bt.purchase_date::text AS purchase
      FROM bank_tx bt
      WHERE bt.einkauf_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM einkauf e WHERE e.bank_tx_id = bt.id)
        AND NOT EXISTS (SELECT 1 FROM income i WHERE i.bank_tx_id = bt.id)
        AND NOT EXISTS (SELECT 1 FROM fixed_cost_check fc WHERE fc.bank_tx_id = bt.id)
        AND NOT EXISTS (SELECT 1 FROM bank_match_suggestion s WHERE s.bank_tx_id = bt.id)
        ${kontoId ? sql`AND bt.konto_id = ${kontoId}` : sql``}
      ORDER BY bt.booking_date DESC, bt.id
      LIMIT 25`;
    if (!open.length) return 0;
    // PRIVATE receipts are never offered to the AI: their merchant text must not
    // leave to a third-party LLM, and a masked suggestion must not be approvable by
    // a non-owner. Private receipts can only be linked manually (konto-scoped picker).
    const receipts = await sql`SELECT id, gesamt_betrag::float8 AS betrag, roh_ladenname, datum::text AS datum FROM einkauf WHERE bank_tx_id IS NULL AND gesamt_betrag IS NOT NULL AND private_for_user_id IS NULL ORDER BY datum DESC LIMIT 400`;
    const incomes = await sql`SELECT id, amount::float8 AS amount, description, datum::text AS datum FROM income WHERE bank_tx_id IS NULL ORDER BY datum DESC LIMIT 120`;
    const fixed = await sql`SELECT id, label, monthly_eur::float8 AS monthly, kind, match_merchant FROM fixed_cost WHERE active LIMIT 250`;
    const near = (v: number, amt: number) => Math.abs(v - amt) <= Math.max(0.5, amt * 0.03);
    type Cand = { kind: 'receipt' | 'income' | 'fixed'; id: number; label: string | null; amount: number; merchant?: string | null; date?: string };
    const items = open.map(bt => {
      const amt = Math.abs(bt.amount as number);
      const debit = (bt.amount as number) < 0;
      const booking = String(bt.booking);
      const lo = isoMinusDays(bt.purchase ? String(bt.purchase) : booking, 12);
      const hi = isoPlusDays(booking, 3);
      const recC: Cand[] = debit ? receipts.filter(r => near(r.betrag as number, amt) && String(r.datum) >= lo && String(r.datum) <= hi).slice(0, 6)
        .map(r => ({ kind: 'receipt', id: r.id as number, label: r.roh_ladenname as string | null, amount: r.betrag as number, date: String(r.datum) })) : [];
      const incC: Cand[] = !debit ? incomes.filter(i => near(i.amount as number, amt) && String(i.datum) >= isoMinusDays(booking, 45) && String(i.datum) <= hi).slice(0, 6)
        .map(i => ({ kind: 'income', id: i.id as number, label: i.description as string | null, amount: i.amount as number, date: String(i.datum) })) : [];
      const fixC: Cand[] = fixed.filter(f => (debit ? f.kind === 'expense' : f.kind === 'income') && near(f.monthly as number, amt)).slice(0, 6)
        .map(f => ({ kind: 'fixed', id: f.id as number, label: f.label as string | null, amount: f.monthly as number, merchant: f.match_merchant as string | null }));
      return { bank_tx_id: bt.id as number, counterparty: bt.counterparty as string | null, description: ((bt.description as string | null) ?? '').slice(0, 120), amount: bt.amount as number, date: booking, candidates: [...recC, ...incC, ...fixC] };
    }).filter(it => it.candidates.length);
    if (!items.length) return 0;

    const system = `Du ordnest Bankbuchungen ihren passenden Nachweisen zu (Beleg, Einnahme oder Fixkosten-Position). Der deterministische Abgleich konnte diese Buchungen NICHT sicher zuordnen; du bist der kreative Zweitversuch.
STRIKTE REGELN:
- Schlage NUR eine Zuordnung vor, wenn du HOCH sicher bist, dass es wirklich derselbe Vorgang ist. Händlernamen dürfen abweichen, wenn es klar dieselbe Firma / derselbe Dienst ist (Weltwissen nutzen: z. B. "RSG Group" = McFit, "nexi" = Zahlungsabwickler eines Ladens, "Congstar" = Handyvertrag).
- Der Betrag muss praktisch identisch sein und das Datum plausibel.
- WICHTIG: Ein gleicher Betrag ALLEIN genügt NICHT. Es muss auch der Händler / Zweck erkennbar zusammenpassen (per Name oder Weltwissen). Zwei unverbundene Firmen mit zufällig gleichem Betrag NICHT zuordnen — das Datum als einziges weiteres Kriterium reicht nicht.
- Im Zweifel KEINE Zuordnung. Es ist viel besser, offen zu lassen, als zu raten. Erfinde NICHTS und wähle NUR aus den je Buchung angebotenen Kandidaten.
- Höchstens EIN Vorschlag pro Buchung — nur der überzeugendste. Überzeugt nichts: weglassen.
Antworte NUR mit JSON: {"matches":[{"bank_tx_id":N,"kind":"receipt|income|fixed","target_id":N,"confidence":0.0-1.0,"reason":"kurz"}]}. Nimm nur Vorschläge mit confidence >= 0.75 auf.`;
    let raw: string;
    try { raw = await (await providerForTask('bankmatch')).chat({ system, user: `Offene Buchungen mit Kandidaten:\n${JSON.stringify(items)}`, json: true }); }
    catch (e) { app.log.warn(`aiMatchBank chat failed: ${(e as Error).message}`); return 0; }
    let matches: { bank_tx_id?: number; kind?: string; target_id?: number; confidence?: number; reason?: string }[] = [];
    try { const j = parseLlmJson<{ matches?: typeof matches }>(raw); matches = Array.isArray(j?.matches) ? j.matches : []; }
    catch { app.log.warn('aiMatchBank: unparseable JSON'); return 0; }
    let n = 0;
    const seen = new Set<number>(); // one accepted proposal per bank_tx (first wins)
    for (const m of matches) {
      const btId = Number(m.bank_tx_id); const tid = Number(m.target_id); const conf = Number(m.confidence); const kind = m.kind;
      if (!btId || !tid || seen.has(btId) || !(conf >= 0.75) || (kind !== 'receipt' && kind !== 'income' && kind !== 'fixed')) continue;
      const it = items.find(x => x.bank_tx_id === btId);
      if (!it || !it.candidates.some(c => c.kind === kind && c.id === tid)) continue; // must be an offered candidate
      try {
        const ins = await sql`INSERT INTO bank_match_suggestion (bank_tx_id, target_kind, einkauf_id, income_id, fixed_cost_id, confidence, reason)
          VALUES (${btId}, ${kind}, ${kind === 'receipt' ? tid : null}, ${kind === 'income' ? tid : null}, ${kind === 'fixed' ? tid : null}, ${conf}, ${String(m.reason ?? '').slice(0, 200)})
          ON CONFLICT (bank_tx_id) DO NOTHING RETURNING id`;
        if (ins.length) { n++; seen.add(btId); }
      } catch { /* skip */ }
    }
    return n;
  };

  /** Analyse an uploaded bank CSV WITHOUT importing: recognise the format (built-in comdirect,
   *  a previously-learned mapping by header fingerprint, or a fresh AI-generated mapping) and
   *  return a preview of the first rows so the user can confirm before it's trusted/stored. */
  app.post('/api/finances/bank/analyze', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const bdy = (req.body ?? {}) as { data_b64?: string };
    if (!bdy.data_b64) return reply.code(400).send({ error: 'data_b64 required' });
    let buf: Buffer;
    try { buf = Buffer.from(bdy.data_b64.replace(/^data:[^,]*,/, ''), 'base64'); }
    catch { return reply.code(400).send({ error: 'bad base64' }); }
    if (!buf.length) return reply.code(400).send({ error: 'empty file' });

    const preview = (rows: { booking_date: string; amount: number; counterparty: string | null; description: string }[]) =>
      rows.slice(0, 8).map(r => ({ booking_date: r.booking_date, amount: r.amount, counterparty: r.counterparty, description: (r.description || '').slice(0, 80) }));

    const sn = sniffCsv(buf);
    // Built-in: comdirect (its counterparty/Ref hide in a free-text field a column-map can't express).
    if (/buchungstag/i.test(sn.headerLine) && /umsatz in eur/i.test(sn.headerLine)) {
      const p = parseComdirectCsv(buf.toString('latin1'));
      return { recognized: true, source: 'builtin', label: 'comdirect', spec: null, total: p.rows.length, preview: preview(p.rows) };
    }
    const fingerprint = fingerprintHeader(sn.headerLine, sn.delimiter);
    const [stored] = await adminSql`SELECT label, spec FROM bank_csv_format WHERE fingerprint = ${fingerprint}`;
    if (stored) {
      const spec: CsvMappingSpec = { ...(stored.spec as CsvMappingSpec), encoding: sn.encoding };
      const p = applyCsvMapping(spec, spec.encoding === 'latin1' ? buf.toString('latin1') : sn.text);
      return { recognized: true, source: 'learned', label: (stored.label as string | null), spec, fingerprint, total: p.rows.length, preview: preview(p.rows) };
    }
    // New format → AI generates a mapping; the user must confirm before it's trusted + stored.
    let spec: CsvMappingSpec;
    try { spec = await generateCsvMapping(sn.headerLine, sn.sampleRows); }
    catch (e) { return { recognized: false, error: `AI-Zuordnung fehlgeschlagen: ${(e as Error).message}`, header: sn.headerLine }; }
    spec.encoding = sn.encoding;
    const p = applyCsvMapping(spec, spec.encoding === 'latin1' ? buf.toString('latin1') : sn.text);
    return { recognized: false, source: 'ai', spec, fingerprint, header: sn.headerLine, total: p.rows.length, preview: preview(p.rows) };
  });

  /** Import a bank CSV into bank_tx for a chosen konto. Built-in comdirect parser, or a generic
   *  mapping spec (from /analyze). Idempotent: rows already present (same konto + ref) are skipped,
   *  so re-importing an overlapping/full-year export never duplicates. Runs auto-matching after.
   *  With save_mapping, remembers the AI mapping so the next CSV of this bank imports automatically. */
  app.post('/api/finances/bank/upload', { bodyLimit: 25 * 1024 * 1024 }, async (req, reply) => {
    const bdy = (req.body ?? {}) as { konto_id?: number; filename?: string; data_b64?: string; spec?: CsvMappingSpec; save_mapping?: boolean; fingerprint?: string; label?: string };
    const kontoId = bdy.konto_id != null ? parseInt(String(bdy.konto_id), 10) : null;
    if (!kontoId) return reply.code(400).send({ error: 'konto_id required' });
    if (!bdy.data_b64) return reply.code(400).send({ error: 'data_b64 required' });
    let buf: Buffer;
    try { buf = Buffer.from(bdy.data_b64.replace(/^data:[^,]*,/, ''), 'base64'); }
    catch { return reply.code(400).send({ error: 'bad base64' }); }
    if (!buf.length) return reply.code(400).send({ error: 'empty file' });

    let parsed;
    if (bdy.spec) {
      const spec = bdy.spec;
      parsed = applyCsvMapping(spec, spec.encoding === 'latin1' ? buf.toString('latin1') : buf.toString('utf-8'));
      if (bdy.save_mapping && bdy.fingerprint && parsed.rows.length) {
        await adminSql`
          INSERT INTO bank_csv_format (fingerprint, label, spec, created_by)
          VALUES (${bdy.fingerprint}, ${bdy.label ?? null}, ${adminSql.json(spec as never)}, ${req.user?.id ?? null})
          ON CONFLICT (fingerprint) DO UPDATE SET spec = EXCLUDED.spec, label = COALESCE(EXCLUDED.label, bank_csv_format.label)`;
      }
    } else {
      parsed = parseComdirectCsv(buf.toString('latin1')); // built-in comdirect (Latin-1)
    }
    if (!parsed.rows.length) {
      return { ok: false, filename: bdy.filename ?? null, reason: 'no transactions found — re-upload to let the AI re-read the format' };
    }
    const batch = `${(bdy.filename ?? 'upload').slice(0, 80)}@${new Date().toISOString()}`;
    // Dedup on (konto, ref): fetch refs already present for this konto, skip them.
    const refs = parsed.rows.map(r => r.ref).filter((r): r is string => !!r);
    const existing = new Set(
      refs.length ? (await sql`SELECT ref FROM bank_tx WHERE konto_id = ${kontoId} AND ref = ANY(${refs})`).map(r => r.ref as string) : [],
    );
    let imported = 0, skipped = 0;
    for (const r of parsed.rows) {
      if (r.ref && existing.has(r.ref)) { skipped++; continue; }
      const ins = await sql`
        INSERT INTO bank_tx (konto_id, booking_date, value_date, purchase_date, amount, counterparty, description, ref, raw, import_batch)
        VALUES (${kontoId}, ${r.booking_date}, ${r.value_date}, ${r.purchase_date}, ${r.amount}, ${r.counterparty}, ${r.description}, ${r.ref}, ${r.raw}, ${batch})
        ON CONFLICT DO NOTHING RETURNING id`;
      if (ins.length) imported++; else skipped++;
    }
    const matched = imported ? (await autoMatchBankByOrder(kontoId)) + (await autoMatchBankByOrderSum(kontoId)) + (await autoMatchBankByOrderSibling(kontoId)) + (await autoMatchBank(kontoId)) + (await autoMatchBankCredits(kontoId)) : 0;
    return { ok: true, filename: bdy.filename ?? null, account: parsed.account, period: parsed.period, imported, skipped, matched, total: parsed.rows.length };
  });

  /** List bank transactions with their match status. `status` filters to
   *  fixed | receipt | open. A row is:
   *   • fixed   → used as evidence for a fixed cost (fixed_cost_check.bank_tx_id)
   *   • receipt → linked to a scanned receipt (einkauf.bank_tx_id)
   *   • open    → neither → likely an un-scanned purchase / unclassified movement.
   *  A linked receipt that is private to someone else is masked (no id/store) for
   *  non-owners; the match status itself still shows. */
  app.get('/api/finances/bank', async (req, reply) => {
    const q = (req.query ?? {}) as { konto?: string; month?: string; status?: string; q?: string };
    const kontoId = q.konto ? parseInt(q.konto, 10) : null;
    const b = q.month?.trim() ? monthBounds(q.month.trim()) : null;
    if (q.month?.trim() && !b) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    const search = (q.q ?? '').trim().toLowerCase();
    const rows = await sql`
      SELECT bt.id, bt.konto_id, k.name AS konto_name,
             bt.booking_date::text AS booking_date, bt.purchase_date::text AS purchase_date,
             bt.amount::float8 AS amount, bt.counterparty, bt.description, bt.ref, bt.review_flag,
             re.id AS receipt_id, re.roh_ladenname AS receipt_laden, re.gesamt_betrag::float8 AS receipt_betrag,
             re.private_for_user_id AS receipt_priv,
             inc.id AS income_id, inc.description AS income_desc, inc.amount::float8 AS income_betrag,
             fx.fixed_id, fx.fixed_label, fx.fixed_kind, fx.fixed_expect, fx.fixed_month,
             sg.target_kind AS sug_kind, sg.target_id AS sug_target_id, sg.target_label AS sug_label,
             sg.confidence::float8 AS sug_confidence, sg.reason AS sug_reason, sg.target_priv AS sug_priv
      FROM bank_tx bt
      LEFT JOIN konto k ON k.id = bt.konto_id
      -- LATERAL … LIMIT 1: a bank_tx may back more than one fixed-cost check (or be
      -- linked to a receipt / income row); take one so the row never fans out.
      -- A receipt is attached either as this booking's PRIMARY (einkauf.bank_tx_id = bt.id)
      -- or as a SIBLING of a split shipment (bt.einkauf_id = e.id) — check both directions.
      LEFT JOIN LATERAL (SELECT e.id, e.roh_ladenname, e.gesamt_betrag, e.private_for_user_id
                         FROM einkauf e WHERE e.bank_tx_id = bt.id OR e.id = bt.einkauf_id LIMIT 1) re ON TRUE
      LEFT JOIN LATERAL (SELECT i.id, i.description, i.amount
                         FROM income i WHERE i.bank_tx_id = bt.id LIMIT 1) inc ON TRUE
      LEFT JOIN LATERAL (SELECT fc.fixed_cost_id AS fixed_id, f.label AS fixed_label, f.kind AS fixed_kind,
                                f.expect_receipt AS fixed_expect, fc.month::text AS fixed_month
                         FROM fixed_cost_check fc JOIN fixed_cost f ON f.id = fc.fixed_cost_id
                         WHERE fc.bank_tx_id = bt.id LIMIT 1) fx ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.target_kind, s.confidence, s.reason,
               COALESCE(s.einkauf_id, s.income_id, s.fixed_cost_id) AS target_id,
               COALESCE(se.roh_ladenname, si.description, sf.label) AS target_label,
               se.private_for_user_id AS target_priv
        FROM bank_match_suggestion s
        LEFT JOIN einkauf se ON se.id = s.einkauf_id
        LEFT JOIN income si ON si.id = s.income_id
        LEFT JOIN fixed_cost sf ON sf.id = s.fixed_cost_id
        WHERE s.bank_tx_id = bt.id LIMIT 1) sg ON TRUE
      WHERE TRUE
        ${kontoId ? sql`AND bt.konto_id = ${kontoId}` : sql``}
        ${b ? sql`AND bt.booking_date BETWEEN ${b.first} AND ${b.last}` : sql``}
      ORDER BY bt.booking_date DESC, bt.id DESC
      LIMIT 3000`;
    const uid = req.user?.id ?? -1;
    const seesAll = !!req.user?.sees_all_konten;
    const items = rows.map(r => {
      const priv = r.receipt_priv as number | null;
      // A bank_tx linked to another user's PRIVATE receipt is masked for them: the
      // AMOUNT stays visible but the text (counterparty/description) is hidden, so a
      // private purchase's merchant (e.g. the shop of a gift) doesn't leak.
      const masked = priv != null && priv !== uid && !seesAll;
      const status = r.receipt_id ? 'receipt' : r.income_id ? 'income' : r.fixed_id ? 'fixed' : 'open';
      return {
        id: r.id, konto_id: r.konto_id, konto_name: r.konto_name,
        booking_date: r.booking_date, purchase_date: r.purchase_date,
        amount: r.amount,
        counterparty: masked ? null : r.counterparty,
        description: masked ? null : r.description,
        private: masked,
        review_flag: r.review_flag === true,
        status,
        receipt: r.receipt_id
          ? (masked ? { id: null, laden: null, betrag: r.receipt_betrag, private: true }
            : { id: r.receipt_id, laden: r.receipt_laden, betrag: r.receipt_betrag, private: false })
          : null,
        income: r.income_id ? { id: r.income_id, description: r.income_desc, betrag: r.income_betrag } : null,
        fixed: r.fixed_id ? { id: r.fixed_id, label: r.fixed_label, kind: r.fixed_kind, expect_receipt: r.fixed_expect, month: (r.fixed_month as string).slice(0, 7) } : null,
        // ⭐ pending AI suggestion (needs approval). A suggested private receipt has its label masked.
        suggestion: r.sug_kind ? (() => {
          const sm = (r.sug_priv as number | null) != null && (r.sug_priv as number | null) !== uid && !seesAll;
          return { kind: r.sug_kind, target_id: r.sug_target_id, label: sm ? null : r.sug_label, confidence: r.sug_confidence, reason: sm ? null : r.sug_reason, private: sm };
        })() : null,
        // ref kept only for the (post-masking) search haystack below, not exposed.
        _ref: (r.ref as string | null) ?? '',
      };
    });
    // Search runs AFTER masking, so a private receipt's masked merchant text can
    // never be probed via search — only the visible fields + amount + bank ref match.
    // Amount matching is done separately with a normalised query so a value typed
    // exactly as shown ("1.234,50", "12,00") matches the stored float ("1234.5").
    const amtQuery = search.replace(/\./g, '').replace(',', '.'); // strip de thousands dots, decimal comma→dot
    const amtSearchable = amtQuery.length > 0 && /\d/.test(amtQuery);
    const searched = search
      ? items.filter(i => {
        const textHay = `${i.counterparty ?? ''} ${i.description ?? ''} ${i._ref}`.toLowerCase();
        if (textHay.includes(search)) return true;
        // amount haystack carries a fixed 2-decimal form so ".X0" amounts match too
        const amtHay = `${i.amount} ${Math.abs(i.amount).toFixed(2)}`;
        return amtSearchable && amtHay.includes(amtQuery);
      })
      : items;
    const filtered = (q.status && ['fixed', 'receipt', 'income', 'open'].includes(q.status)
      ? searched.filter(i => i.status === q.status) : searched)
      .map(({ _ref, ...rest }) => rest); // drop the internal search field from the payload
    // Summary counts (over the current konto/month/search scope, before status filter).
    const counts = { all: searched.length, open: 0, fixed: 0, receipt: 0, income: 0 };
    for (const i of searched) counts[i.status as 'open' | 'fixed' | 'receipt' | 'income']++;
    return { items: filtered, counts };
  });

  /** Imported CSV batches: one row per (import_batch, konto) with count + import date.
   *  Lets the user see what was imported, when, and onto which account. */
  app.get('/api/finances/bank/batches', async () => {
    const rows = await sql`
      SELECT bt.import_batch, bt.konto_id, k.name AS konto_name,
             COUNT(*)::int AS n, MIN(bt.imported_at)::text AS imported_at,
             MIN(bt.booking_date)::text AS first_date, MAX(bt.booking_date)::text AS last_date
      FROM bank_tx bt LEFT JOIN konto k ON k.id = bt.konto_id
      WHERE bt.import_batch IS NOT NULL
      GROUP BY bt.import_batch, bt.konto_id, k.name
      ORDER BY MIN(bt.imported_at) DESC`;
    return {
      batches: rows.map(r => ({
        batch: r.import_batch,
        filename: String(r.import_batch).split('@')[0],
        konto_id: r.konto_id, konto_name: r.konto_name,
        n: r.n, imported_at: r.imported_at, first_date: r.first_date, last_date: r.last_date,
      })),
    };
  });

  /** Delete a single bank transaction (mis-import). FK links (fixed_cost_check,
   *  einkauf) are ON DELETE SET NULL, so a linked receipt/check just loses the link. */
  app.delete('/api/finances/bank/:id', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    await sql.begin(async tx => {
      // If this booking is a split-shipment PRIMARY, detach its receipt's siblings too,
      // so deleting it doesn't leave a receipt with siblings but no primary (the FK only
      // nulls einkauf.bank_tx_id). Keyed off the primary → run BEFORE the delete.
      await tx`UPDATE bank_tx SET einkauf_id = NULL WHERE einkauf_id IN (SELECT id FROM einkauf WHERE bank_tx_id = ${id})`;
      await tx`DELETE FROM bank_tx WHERE id = ${id}`;
    });
    return { ok: true };
  });

  /** Undo a whole CSV import: delete every bank_tx row of one import_batch. For the
   *  common mistake of picking the wrong account (or a bad column mapping). Linked
   *  receipts/income/fixed-cost checks are ON DELETE SET NULL, so they survive but
   *  lose the bank link — re-importing onto the right account re-matches them. */
  app.post('/api/finances/bank/undo-import', async (req, reply) => {
    const batch = String((req.body as { batch?: string } | undefined)?.batch ?? '').trim();
    if (!batch) return reply.code(400).send({ error: 'batch required' });
    const result = await sql.begin(async tx => {
      // Count links about to be broken, so the UI can tell the user what it cost.
      const [pre] = await tx`SELECT
        (SELECT COUNT(*)::int FROM einkauf          WHERE bank_tx_id IN (SELECT id FROM bank_tx WHERE import_batch = ${batch})) AS receipts,
        (SELECT COUNT(*)::int FROM income           WHERE bank_tx_id IN (SELECT id FROM bank_tx WHERE import_batch = ${batch})) AS income,
        (SELECT COUNT(*)::int FROM fixed_cost_check WHERE bank_tx_id IN (SELECT id FROM bank_tx WHERE import_batch = ${batch})) AS checks`;
      // Detach split-shipment siblings (see single-row delete) before removing the rows.
      await tx`UPDATE bank_tx SET einkauf_id = NULL
               WHERE einkauf_id IN (SELECT id FROM einkauf WHERE bank_tx_id IN (SELECT id FROM bank_tx WHERE import_batch = ${batch}))`;
      const del = await tx`DELETE FROM bank_tx WHERE import_batch = ${batch} RETURNING id`;
      return { deleted: del.length, unlinked: (pre.receipts as number) + (pre.income as number) + (pre.checks as number) };
    });
    if (result.deleted === 0) return reply.code(404).send({ error: 'no such import' });
    return { ok: true, ...result };
  });

  /** Guard (run inside a tx that holds the bank_tx row FOR UPDATE): a line that
   *  already backs a receipt / income row / fixed-cost check must not get a second
   *  generated home. Closes the generate-vs-generate / generate-vs-link race. */
  async function assertBankTxOpen(tx: Tx, id: number): Promise<void> {
    const [st] = await tx`SELECT
      EXISTS(SELECT 1 FROM einkauf WHERE bank_tx_id = ${id}) AS r,
      EXISTS(SELECT 1 FROM income WHERE bank_tx_id = ${id}) AS i,
      EXISTS(SELECT 1 FROM fixed_cost_check WHERE bank_tx_id = ${id}) AS f`;
    if (st.r || st.i || st.f) throw new HttpError(400, 'Diese Buchung ist bereits zugeordnet');
  }

  /** Generate a stand-in RECEIPT for an un-scanned purchase (a debit we forgot to
   *  photograph). One dummy "Unbekannter Einkauf" line in Sonstiges carries the
   *  exact amount; the receipt is linked back to the bank line. */
  app.post('/api/finances/bank/:id/generate-receipt', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const bodyLaden = ((req.body as { laden?: string } | undefined)?.laden ?? '').toString().trim();
    try {
      const einkaufId = await sql.begin(async tx => {
        const [bt] = await tx`SELECT konto_id, booking_date::text AS booking, amount::float8 AS amount, counterparty FROM bank_tx WHERE id = ${id} FOR UPDATE`;
        if (!bt) throw new HttpError(404, 'not found');
        if ((bt.amount as number) >= 0) throw new HttpError(400, 'Nur für Ausgaben (Belastungen). Für Gutschriften „Fixkosten/Einnahme" generieren.');
        if (bt.konto_id == null) throw new HttpError(400, 'Buchung ohne Konto');
        await assertBankTxOpen(tx, id);
        const laden = bodyLaden || (bt.counterparty as string | null) || 'Unbekannt';
        const amount = Math.abs(bt.amount as number);
        const [e] = await tx`
          INSERT INTO einkauf (datum, roh_ladenname, gesamt_betrag, konto_id, quelle, geprueft, ocr_pending, date_uncertain, bank_tx_id)
          VALUES (${bt.booking}, ${laden}, ${amount}, ${bt.konto_id}, 'generated', TRUE, FALSE, FALSE, ${id})
          RETURNING id`;
        await tx`
          INSERT INTO artikel (einkauf_id, name, canonical_name, menge, preis, category_path)
          VALUES (${e.id}, 'Unbekannter Einkauf', 'Unbekannter Einkauf', 1, ${amount}, 'Sonstiges/Unkategorisiert')`;
        return e.id as number;
      });
      return { ok: true, einkauf_id: einkaufId };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.code).send({ error: e.message });
      throw e;
    }
  });

  /** Generate a FIXED-COST entry from a bank line — the escape hatch for one-off
   *  transfers/top-ups (e.g. a 2500 € booster on top of the monthly 2000). It never
   *  gets folded onto an existing monthly ration (which would break 1:1 matching);
   *  instead it becomes its own row, optionally scoped to just the booking month via
   *  start/end date, and the bank line is linked as its confirmed evidence. */
  app.post('/api/finances/bank/:id/generate-fixed', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const body = (req.body ?? {}) as { label?: string; kind?: string; is_transfer?: boolean; one_month?: boolean };
    try {
      const fixedId = await sql.begin(async tx => {
        const [bt] = await tx`SELECT konto_id, booking_date::text AS booking, amount::float8 AS amount, counterparty FROM bank_tx WHERE id = ${id} FOR UPDATE`;
        if (!bt) throw new HttpError(404, 'not found');
        if (bt.konto_id == null) throw new HttpError(400, 'Buchung ohne Konto');
        await assertBankTxOpen(tx, id);
        const label = (body.label ?? '').toString().trim() || (bt.counterparty as string | null) || 'Fixkosten';
        const kind = body.kind === 'income' ? 'income' : body.kind === 'expense' ? 'expense' : ((bt.amount as number) >= 0 ? 'income' : 'expense');
        const amount = Math.abs(bt.amount as number);
        const month = String(bt.booking).slice(0, 7);
        const mb = monthBounds(month);
        if (!mb) throw new HttpError(400, 'bad booking date');
        const start = `${month}-01`;
        const oneOff = body.one_month !== false;               // default: scoped to the booking month → a one-off
        const end = oneOff ? mb.last : null;
        const [f] = await tx`
          INSERT INTO fixed_cost (label, category_path, monthly_eur, kind, frequency, is_transfer, konto_id, start_date, end_date, active, expect_receipt, match_merchant, one_off, created_by)
          VALUES (${label}, NULL, ${amount}, ${kind}, 'monthly', ${body.is_transfer === true}, ${bt.konto_id}, ${start}, ${end}, TRUE, FALSE, NULL, ${oneOff}, ${req.user?.id ?? null})
          RETURNING id`;
        await tx`
          INSERT INTO fixed_cost_check (fixed_cost_id, month, status, bank_tx_id, amount, decided_by)
          VALUES (${f.id}, ${start}, 'confirmed', ${id}, ${amount}, ${req.user?.id ?? null})
          ON CONFLICT (fixed_cost_id, month) DO UPDATE SET bank_tx_id = EXCLUDED.bank_tx_id, amount = EXCLUDED.amount, status = 'confirmed'`;
        return f.id as number;
      });
      return { ok: true, fixed_cost_id: fixedId };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.code).send({ error: e.message });
      throw e;
    }
  });

  /** Toggle the shared household "needs a closer look" marker on a bank statement
   *  line (set via long-press in the Auszüge list). Pure review aid — no matching
   *  effect; visible to and toggleable by every household member. */
  app.post('/api/finances/bank/:id/flag', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const flag = (req.body as { flag?: unknown } | undefined)?.flag === true;
    const [row] = await sql`UPDATE bank_tx SET review_flag = ${flag} WHERE id = ${id} RETURNING id, review_flag`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { ok: true, review_flag: row.review_flag };
  });

  /** Re-run matching: deterministic first (writes real links), then the creative
   *  AI pass (writes ⭐ suggestions that need human approval). `ai:false` skips the
   *  LLM step. */
  app.post('/api/finances/bank/rematch', async (req) => {
    const body = (req.body ?? {}) as { konto_id?: number; ai?: boolean };
    const kontoId = body.konto_id != null ? parseInt(String(body.konto_id), 10) : null;
    const linked = (await autoMatchBankByOrder(kontoId)) + (await autoMatchBankByOrderSum(kontoId)) + (await autoMatchBankByOrderSibling(kontoId)) + (await autoMatchBank(kontoId)) + (await autoMatchBankCredits(kontoId));
    let suggested = 0;
    if (body.ai !== false) {
      try { suggested = await aiMatchBank(kontoId); }
      catch (e) { app.log.warn(`aiMatchBank failed: ${(e as Error).message}`); }
    }
    return { ok: true, linked, suggested };
  });

  /** Approve a ⭐ AI match suggestion → turn it into the real link (receipt/income/
   *  fixed-cost evidence) and delete the suggestion. Re-checks the line is still open. */
  app.post('/api/finances/bank/:id/suggestion/approve', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    try {
      await sql.begin(async tx => {
        const [s] = await tx`SELECT target_kind, einkauf_id, income_id, fixed_cost_id FROM bank_match_suggestion WHERE bank_tx_id = ${id} FOR UPDATE`;
        if (!s) throw new HttpError(404, 'kein Vorschlag');
        // "Still open" must also mean "not already a split-shipment SIBLING": a stale
        // suggestion on a debit a matcher has meanwhile attached to receipt R would
        // otherwise be approved as receipt Q's primary, and the same money would count
        // towards both invoices' coverage. (aiMatchBank excludes such debits when it
        // WRITES suggestions; this is the same guard on the approve path.)
        const [open] = await tx`SELECT
          EXISTS(SELECT 1 FROM einkauf WHERE bank_tx_id = ${id}) AS r,
          EXISTS(SELECT 1 FROM income WHERE bank_tx_id = ${id}) AS i,
          EXISTS(SELECT 1 FROM fixed_cost_check WHERE bank_tx_id = ${id}) AS f,
          EXISTS(SELECT 1 FROM bank_tx WHERE id = ${id} AND einkauf_id IS NOT NULL) AS s`;
        if (open.r || open.i || open.f || open.s) throw new HttpError(400, 'Buchung ist bereits zugeordnet');
        if (s.target_kind === 'receipt' && s.einkauf_id) {
          const [e] = await tx`SELECT bank_tx_id, private_for_user_id FROM einkauf WHERE id = ${s.einkauf_id} FOR UPDATE`;
          if (!e) throw new HttpError(400, 'Beleg nicht mehr vorhanden');
          // Owner guard (like the manual /link + guardReceipt): never let a non-owner
          // link someone else's PRIVATE receipt (belt-and-suspenders — the matcher
          // already excludes private receipts from candidates).
          const pf = e.private_for_user_id as number | null;
          if (pf != null && pf !== (req.user?.id ?? null) && !req.user?.sees_all_konten) throw new HttpError(403, 'forbidden');
          if (e.bank_tx_id != null) throw new HttpError(400, 'Beleg ist schon verknüpft');
          await tx`UPDATE einkauf SET bank_tx_id = ${id} WHERE id = ${s.einkauf_id}`;
        } else if (s.target_kind === 'income' && s.income_id) {
          const [i] = await tx`SELECT bank_tx_id FROM income WHERE id = ${s.income_id} FOR UPDATE`;
          if (!i) throw new HttpError(400, 'Einnahme nicht mehr vorhanden');
          if (i.bank_tx_id != null) throw new HttpError(400, 'Einnahme ist schon verknüpft');
          await tx`UPDATE income SET bank_tx_id = ${id} WHERE id = ${s.income_id}`;
        } else if (s.target_kind === 'fixed' && s.fixed_cost_id) {
          const [bt] = await tx`SELECT booking_date::text AS booking, amount::float8 AS amount FROM bank_tx WHERE id = ${id}`;
          const [f] = await tx`SELECT frequency FROM fixed_cost WHERE id = ${s.fixed_cost_id}`;
          if (!bt || !f) throw new HttpError(400, 'Fixkosten-Position nicht mehr vorhanden');
          const checkMonth = anchorMonth(`${String(bt.booking).slice(0, 7)}-01`, f.frequency as string | null);
          // Don't silently overwrite a month already confirmed by other evidence.
          const [existing] = await tx`SELECT status FROM fixed_cost_check WHERE fixed_cost_id = ${s.fixed_cost_id} AND month = ${checkMonth}`;
          if (existing && existing.status === 'confirmed') throw new HttpError(400, 'Dieser Monat ist für diese Fixkosten-Position bereits bestätigt');
          await tx`INSERT INTO fixed_cost_check (fixed_cost_id, month, status, bank_tx_id, amount, decided_by)
            VALUES (${s.fixed_cost_id}, ${checkMonth}, 'confirmed', ${id}, ${Math.abs(bt.amount as number)}, ${req.user?.id ?? null})
            ON CONFLICT (fixed_cost_id, month) DO UPDATE SET bank_tx_id = EXCLUDED.bank_tx_id, amount = EXCLUDED.amount, status = 'confirmed'`;
        } else throw new HttpError(400, 'ungültiger Vorschlag');
        await tx`DELETE FROM bank_match_suggestion WHERE bank_tx_id = ${id}`;
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.code).send({ error: e.message });
      throw e;
    }
  });

  /** Dismiss a ⭐ AI match suggestion (it was wrong) — just delete it. */
  app.post('/api/finances/bank/:id/suggestion/dismiss', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    await sql`DELETE FROM bank_match_suggestion WHERE bank_tx_id = ${id}`;
    return { ok: true };
  });

  /** Candidates to manually link to a bank transaction. A DEBIT (< 0) offers scanned
   *  receipts near the amount + purchase-date window (private ones the caller can't
   *  see are excluded); a CREDIT (> 0) offers actual income rows near the amount with
   *  a wide date window (pay slips are dated month-01, the bank books the pay day). */
  app.get('/api/finances/bank/:id/candidates', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const [bt] = await sql`SELECT amount::float8 AS amount, booking_date::text AS booking, purchase_date::text AS purchase FROM bank_tx WHERE id = ${id}`;
    if (!bt) return reply.code(404).send({ error: 'not found' });
    const target = Math.abs(bt.amount as number);
    const tol = Math.max(0.5, target * 0.02);
    if ((bt.amount as number) < 0) {
      const hi = isoPlusDays(String(bt.booking), 1);
      const lo = isoMinusDays(bt.purchase ? String(bt.purchase) : String(bt.booking), 14);
      const rows = await sql`
        SELECT e.id, e.roh_ladenname AS label, e.gesamt_betrag::float8 AS betrag, e.datum::text AS datum
        FROM einkauf e
        WHERE e.gesamt_betrag IS NOT NULL
          -- Match this statement to the receipt's REMAINING uncovered value (total minus the
          -- statements already attached, either link direction), NOT the full total. So a
          -- split shipment's next debit is suggested, and a fully-covered receipt drops out —
          -- go by exact remaining value, not "has ≥1 statement".
          AND ABS((e.gesamt_betrag - COALESCE((SELECT SUM(ABS(bt2.amount)) FROM bank_tx bt2 WHERE bt2.einkauf_id = e.id OR bt2.id = e.bank_tx_id), 0)) - ${target}) <= ${tol}
          AND e.datum BETWEEN ${lo} AND ${hi}
          ${kontoScope(req.user, sql`e`)}
        ORDER BY ABS((e.gesamt_betrag - COALESCE((SELECT SUM(ABS(bt2.amount)) FROM bank_tx bt2 WHERE bt2.einkauf_id = e.id OR bt2.id = e.bank_tx_id), 0)) - ${target}), e.datum DESC
        LIMIT 40`;
      return { kind: 'receipt', candidates: rows };
    }
    const hi = isoPlusDays(String(bt.booking), 10);
    const lo = isoMinusDays(String(bt.booking), 45);
    const rows = await sql`
      SELECT i.id, i.description AS label, i.amount::float8 AS betrag, i.datum::text AS datum
      FROM income i
      WHERE i.bank_tx_id IS NULL
        AND ABS(i.amount - ${target}) <= ${tol}
        AND i.datum BETWEEN ${lo} AND ${hi}
      ORDER BY ABS(i.amount - ${target}), i.datum DESC
      LIMIT 40`;
    return { kind: 'income', candidates: rows };
  });

  /** Free-text receipt/income search for the manual link picker. Unlike /candidates
   *  (pre-filtered by amount + date window), this finds ANY still-unlinked receipt the
   *  user believes is correct — by merchant, an item name, amount, or date. Amount &
   *  date are returned so a deliberate mismatch (e.g. an Amazon part-shipment) is
   *  visible before linking. Same konto/privacy scope as /candidates. */
  app.get('/api/finances/bank/:id/search-receipts', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const q = String((req.query as { q?: string }).q ?? '').trim();
    const [bt] = await sql`SELECT amount::float8 AS amount, einkauf_id FROM bank_tx WHERE id = ${id}`;
    if (!bt) return reply.code(404).send({ error: 'not found' });
    const credit = (bt.amount as number) > 0;
    if (!q) return { kind: credit ? 'income' : 'receipt', results: [] };
    const like = `%${q}%`;
    // Accept an amount typed the German way ("112,03" / "1.234,50") as a numeric match.
    const amtQ = q.replace(/\./g, '').replace(',', '.');
    const amtNum = /^\d+(\.\d+)?$/.test(amtQ) ? parseFloat(amtQ) : null;
    if (credit) {
      const rows = await sql`
        SELECT i.id, i.description AS label, i.amount::float8 AS betrag, i.datum::text AS datum
        FROM income i
        WHERE i.bank_tx_id IS NULL
          AND (i.description ILIKE ${like} OR i.source ILIKE ${like}
               ${amtNum != null ? sql`OR ABS(i.amount - ${amtNum}) <= 0.01` : sql``}
               OR i.datum::text ILIKE ${like})
        ORDER BY i.datum DESC
        LIMIT 40`;
      return { kind: 'income', results: rows };
    }
    const rows = await sql`
      SELECT e.id, e.roh_ladenname AS label, e.gesamt_betrag::float8 AS betrag, e.datum::text AS datum
      FROM einkauf e
      -- NOT restricted to unlinked receipts: with split shipments a receipt that already
      -- has a (primary) booking can still take another sibling debit. Exclude only the
      -- ones already tied to THIS booking (nothing to add). Order unlinked-first.
      WHERE e.gesamt_betrag IS NOT NULL
        AND e.bank_tx_id IS DISTINCT FROM ${id} AND e.id IS DISTINCT FROM ${bt.einkauf_id ?? null}
        -- Hide receipts already FULLY covered: the statements attached to them (either link
        -- direction) already sum to the receipt total. A partially-covered split (e.g. an
        -- Amazon order paid per shipment) still shows — it needs more. Go by exact value,
        -- not "has ≥1 statement", so multi-statement receipts aren't wrongly hidden.
        AND COALESCE((SELECT SUM(ABS(bt2.amount)) FROM bank_tx bt2 WHERE bt2.einkauf_id = e.id OR bt2.id = e.bank_tx_id), 0) < e.gesamt_betrag - 0.005
        AND (e.roh_ladenname ILIKE ${like}
             ${amtNum != null ? sql`OR ABS(e.gesamt_betrag - ${amtNum}) <= 0.01` : sql``}
             OR e.datum::text ILIKE ${like}
             OR EXISTS (SELECT 1 FROM artikel a WHERE a.einkauf_id = e.id AND a.name ILIKE ${like}))
        ${kontoScope(req.user, sql`e`)}
      ORDER BY (e.bank_tx_id IS NOT NULL), e.datum DESC
      LIMIT 40`;
    return { kind: 'receipt', results: rows };
  });

  /** Manually link a bank transaction to a receipt (debit) or income row (credit),
   *  one-to-one. Atomic: verify the target is visible + still unlinked BEFORE
   *  detaching the old one, so a bad/stale target never destroys a valid link; a slot
   *  held by another user's PRIVATE receipt can't be hijacked. */
  app.post('/api/finances/bank/:id/link', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    const body = (req.body ?? {}) as { einkauf_id?: number; income_id?: number };
    if (!id) return reply.code(400).send({ error: 'bad id' });
    const [bt] = await sql`SELECT id, amount::float8 AS amount, konto_id FROM bank_tx WHERE id = ${id}`;
    if (!bt) return reply.code(404).send({ error: 'bank tx not found' });
    const uid = req.user?.id ?? -1;
    const seesAll = !!req.user?.sees_all_konten;
    if ((bt.amount as number) < 0) {
      const eid = parseInt(String(body.einkauf_id ?? ''), 10);
      if (!eid) return reply.code(400).send({ error: 'einkauf_id required' });
      let linkedId: number | null = null;                 // set only on the success path
      const err = await sql.begin(async tx => {
        // Whatever this booking is currently attached to — primary (einkauf.bank_tx_id)
        // OR sibling of a split (bank_tx.einkauf_id) — guard a non-owner's private receipt.
        // FOR UPDATE so the current holder can't change between this check and the
        // detach below (else a concurrent tx could swap in a different — possibly
        // private — receipt and the unscoped detach would null the wrong one).
        const [cur] = await tx`
          SELECT e.id, e.private_for_user_id AS priv FROM einkauf e
          WHERE e.bank_tx_id = ${id} OR e.id = (SELECT einkauf_id FROM bank_tx WHERE id = ${id}) LIMIT 1 FOR UPDATE`;
        if (cur && cur.priv != null && cur.priv !== uid && !seesAll) {
          return { code: 403, error: 'bank transaction already linked to a private receipt' };
        }
        // Target must be visible; it MAY already have a primary (that's how a split
        // shipment adds another sibling debit to the same receipt).
        const [target] = await tx`
          SELECT id, bank_tx_id FROM einkauf
          WHERE id = ${eid} AND (${seesAll} OR private_for_user_id IS NULL OR private_for_user_id = ${uid})
          FOR UPDATE`;
        if (!target) { return { code: 404, error: 'receipt not found' }; }
        // Detach this booking from its old primary receipt (by the exact row we locked
        // + privacy-checked, not a re-matched WHERE) unless it's the target itself.
        if (cur && cur.id !== target.id) await tx`UPDATE einkauf SET bank_tx_id = NULL WHERE id = ${cur.id}`;
        await tx`UPDATE bank_tx SET einkauf_id = ${target.id} WHERE id = ${id}`;
        // Become the target's primary only if it has none yet (drives receipt-detail + evidence).
        await tx`UPDATE einkauf SET bank_tx_id = ${id} WHERE id = ${target.id} AND bank_tx_id IS NULL`;
        linkedId = target.id as number;
        return null;
      });
      if (err) return reply.code(err.code).send({ error: err.error });
      // Canonicalise: the invoice now sits on the account that actually paid it; learn the
      // biller -> account so its future invoices self-file there. (Mismatch is confirmed
      // in the UI before we get here.)
      if (linkedId != null) await alignInvoiceToBank(linkedId, id, (bt.konto_id as number | null) ?? null);
      return { ok: true };
    }
    // Credit → income row (income is shared finance data, no per-row privacy).
    const iid = parseInt(String(body.income_id ?? ''), 10);
    if (!iid) return reply.code(400).send({ error: 'income_id required' });
    return await sql.begin(async tx => {
      const [target] = await tx`SELECT id FROM income WHERE id = ${iid} AND bank_tx_id IS NULL FOR UPDATE`;
      if (!target) { reply.code(404); return { error: 'income not found or already linked' }; }
      await tx`UPDATE income SET bank_tx_id = NULL WHERE bank_tx_id = ${id}`;
      await tx`UPDATE income SET bank_tx_id = ${id} WHERE id = ${target.id}`;
      return { ok: true };
    });
  });

  /** Unlink whatever receipt / income row is attached to this bank transaction.
   *  Receipt side is scoped so a non-owner can't detach someone's private receipt. */
  app.post('/api/finances/bank/:id/unlink', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'bad id' });
    await sql.begin(async tx => {
      // If this booking is the PRIMARY of a split-shipment receipt, that receipt may
      // also have SIBLING debits (bank_tx.einkauf_id = receipt). Detaching only this
      // booking would orphan the receipt (primary gone, siblings still pointing at it),
      // so fully detach the receipt: clear every sibling's link first (keyed off the
      // primary, so BEFORE nulling einkauf.bank_tx_id).
      await tx`UPDATE bank_tx SET einkauf_id = NULL
        WHERE einkauf_id IN (SELECT e.id FROM einkauf e WHERE e.bank_tx_id = ${id} ${kontoScope(req.user, sql`e`)})`;
      await tx`UPDATE einkauf SET bank_tx_id = NULL WHERE bank_tx_id = ${id} ${kontoScope(req.user, sql`einkauf`)}`;
      // Drop THIS booking's own sibling link too (case: it was a sibling, not a primary),
      // scoped so a non-owner can't detach a booking tied to someone else's private receipt.
      await tx`UPDATE bank_tx SET einkauf_id = NULL WHERE id = ${id}
        AND (einkauf_id IS NULL OR EXISTS (SELECT 1 FROM einkauf e WHERE e.id = bank_tx.einkauf_id ${kontoScope(req.user, sql`e`)}))`;
      await tx`UPDATE income SET bank_tx_id = NULL WHERE bank_tx_id = ${id}`;
    });
    return { ok: true };
  });

  // ── Budgets (custom groups over Warenkategorien) ──────────────────────────

  app.post('/api/budgets', async (req, reply) => {
    const bdy = (req.body ?? {}) as { label?: string; monthly_target?: unknown; konto_id?: number | null; categories?: string[] };
    const label = (bdy.label ?? '').toString().trim();
    const target = toNum(bdy.monthly_target);
    const cats = [...new Set((bdy.categories ?? []).map(c => c.trim()).filter(Boolean))];
    if (!label) return reply.code(400).send({ error: 'label required' });
    if (target == null || target < 0) return reply.code(400).send({ error: 'monthly_target must be >= 0' });
    if (!cats.length) return reply.code(400).send({ error: 'at least one category required' });
    const [row] = await sql`
      INSERT INTO budget (label, monthly_target, konto_id, created_by)
      VALUES (${label}, ${target}, ${bdy.konto_id ?? null}, ${req.user?.id ?? null}) RETURNING id`;
    for (const c of cats) await sql`INSERT INTO budget_category (budget_id, category_path) VALUES (${row.id}, ${c})`;
    return { ok: true, id: row.id };
  });

  app.patch('/api/budgets/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const bdy = (req.body ?? {}) as { label?: string; monthly_target?: unknown; konto_id?: number | null; categories?: string[]; active?: boolean };
    const updates: Record<string, unknown> = {};
    if ('label' in bdy) {
      const l = (bdy.label ?? '').toString().trim();
      if (!l) return reply.code(400).send({ error: 'label cannot be empty' });
      updates.label = l;
    }
    if ('monthly_target' in bdy) {
      const tgt = toNum(bdy.monthly_target);
      if (tgt == null || tgt < 0) return reply.code(400).send({ error: 'monthly_target must be >= 0' });
      updates.monthly_target = tgt;
    }
    if ('konto_id' in bdy) updates.konto_id = bdy.konto_id ?? null;
    if ('active' in bdy) updates.active = !!bdy.active;
    if (Object.keys(updates).length) {
      const [row] = await sql`UPDATE budget SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
      if (!row) return reply.code(404).send({ error: 'not found' });
    }
    if (Array.isArray(bdy.categories)) {
      const cats = [...new Set(bdy.categories.map(c => c.trim()).filter(Boolean))];
      if (!cats.length) return reply.code(400).send({ error: 'at least one category required' });
      await sql.begin(async tx => {
        await tx`DELETE FROM budget_category WHERE budget_id = ${id}`;
        for (const c of cats) await tx`INSERT INTO budget_category (budget_id, category_path) VALUES (${id}, ${c})`;
      });
    }
    return { ok: true };
  });

  app.delete('/api/budgets/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    await sql`DELETE FROM budget WHERE id = ${id}`;
    return { ok: true };
  });

  /** Drill-down: the individual article positions that make up a budget's "Ist"
   *  (actual) for a month. Same filter as the month view's actual sum (category-
   *  prefix match, the budget's own konto scope, fixed-cost-evidence receipts
   *  excluded) — so `total` equals the displayed Ist exactly.
   *
   *  Privacy: a receipt marked private (private_for_user_id) still CONTRIBUTES its
   *  amount to the household budget, but its DETAILS (item name, store, category,
   *  date, link) are masked server-side for anyone who is neither the owner nor a
   *  super-admin — they only see "Privater Einkauf" + the amount. The sensitive
   *  fields never leave the server for those users. */
  app.get('/api/finances/budget/:id/positions', async (req, reply) => {
    const id = parseInt(String((req.params as { id: string }).id), 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    const q = req.query as { month?: string; konten?: string };
    const b = monthBounds((q.month ?? '').trim());
    if (!b) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    // Same account scope as the month tile (charged account = einkauf.konto_id) so the
    // drill-down total matches the tile's Ist under a person/household filter.
    const kIds = (q.konten ?? '').trim() ? q.konten!.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite) : null;
    const posKonto = kIds && kIds.length ? sql`AND e.konto_id = ANY(${kIds})` : sql``;
    const rows = await sql`
      SELECT a.id, COALESCE(NULLIF(a.canonical_name, ''), a.name) AS name,
             a.preis::float8 AS preis, a.menge::float8 AS menge, a.einheit, a.category_path,
             e.id AS einkauf_id, e.datum::text AS datum, e.roh_ladenname AS laden,
             e.private_for_user_id
      FROM budget bu
      JOIN artikel a ON a.preis IS NOT NULL AND a.category_path IS NOT NULL
        AND EXISTS (SELECT 1 FROM budget_category bc WHERE bc.budget_id = bu.id
                    AND (a.category_path = bc.category_path OR a.category_path LIKE bc.category_path || '/%'))
      JOIN einkauf e ON e.id = a.einkauf_id
      WHERE bu.id = ${id} AND bu.active AND e.datum BETWEEN ${b.first} AND ${b.last}
        AND (bu.konto_id IS NULL OR e.konto_id = bu.konto_id)
        ${posKonto}
        AND NOT EXISTS (SELECT 1 FROM fixed_cost_check fc WHERE fc.einkauf_id = e.id)
      ORDER BY e.datum DESC, a.id
    `;
    const uid = req.user?.id ?? -1;
    const seesAll = !!req.user?.sees_all_konten;
    const positions = rows.map((r, i) => {
      const priv = r.private_for_user_id as number | null;
      const masked = priv != null && priv !== uid && !seesAll;
      return masked
        // Synthetic negative id as a stable React key; every sensitive field nulled.
        ? { id: -(i + 1), name: null, preis: r.preis as number, menge: null, einheit: null, category_path: null, einkauf_id: null, datum: null, laden: null, private: true }
        : { id: r.id, name: r.name, preis: r.preis, menge: r.menge, einheit: r.einheit, category_path: r.category_path, einkauf_id: r.einkauf_id, datum: r.datum, laden: r.laden, private: false };
    });
    const total = Math.round(positions.reduce((s, r) => s + Number(r.preis), 0) * 100) / 100;
    return { positions, total };
  });
}
