import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';
import { extractPayslip } from '../llm/ocr.js';

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

  /** All fixed costs with their konto scope (household vs which person). */
  app.get('/api/fixed-costs', async () => {
    return sql`
      SELECT f.id, f.label, f.category_path, f.monthly_eur::float8 AS monthly_eur, f.kind, f.frequency, f.is_transfer,
             f.konto_id, f.start_date, f.end_date, f.active,
             f.expect_receipt, f.match_merchant,
             k.name AS konto_name, k.is_shared, k.user_id AS konto_user_id, u.username AS owner
      FROM fixed_cost f
      LEFT JOIN konto k ON k.id = f.konto_id
      LEFT JOIN users u ON u.id = k.user_id
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
    const [row] = await sql`
      INSERT INTO fixed_cost (label, category_path, monthly_eur, kind, frequency, is_transfer, konto_id, start_date, end_date, active, expect_receipt, match_merchant, created_by)
      VALUES (${label}, ${category}, ${monthly}, ${kind}, ${freq}, ${b.is_transfer === true}, ${kontoId}, ${start}, ${end}, ${b.active !== false},
              ${b.expect_receipt !== false}, ${(b.match_merchant ?? '').toString().trim() || null}, ${req.user?.id ?? null})
      RETURNING id`;
    return { ok: true, id: row.id };
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
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'no patchable fields' });
    const [row] = await sql`UPDATE fixed_cost SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/fixed-costs/:id', async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    if (!id) return reply.code(400).send({ error: 'invalid id' });
    await sql`DELETE FROM fixed_cost WHERE id = ${id}`;
    return { ok: true };
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
  const normMerchant = (s: string): string =>
    s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9äöüß ]/gi, ' ').replace(/\s+/g, ' ').trim();

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

    // 1) Recurring plans active this month + their check. `kind` splits them into
    //    expenses (Fixkosten) and income (Einnahmen-Soll); both share the same
    //    check + evidence-matching engine, just against different evidence pools.
    const fixed = await sql`
      SELECT f.id, f.label, f.monthly_eur::float8 AS monthly_eur, f.kind, f.frequency, f.is_transfer, f.expect_receipt, f.match_merchant,
             f.konto_id, k.name AS konto_name, k.is_shared, u.username AS owner,
             c.id AS check_id, c.status AS check_status, c.einkauf_id AS check_einkauf_id,
             c.bank_tx_id AS check_bank_tx_id, c.income_id AS check_income_id, c.amount::float8 AS check_amount,
             CASE WHEN c.einkauf_id IS NOT NULL THEN 'receipt'
                  WHEN c.bank_tx_id IS NOT NULL THEN 'bank'
                  WHEN c.income_id IS NOT NULL THEN 'income' ELSE 'none' END AS check_source,
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
    const receipts = await sql`
      SELECT e.id, e.datum::text AS datum, e.roh_ladenname, e.gesamt_betrag::float8 AS gesamt_betrag
      FROM einkauf e
      WHERE e.datum BETWEEN ${b.first} AND ${b.last} AND e.gesamt_betrag IS NOT NULL
        AND e.quelle IN ('email', 'upload')
        ${kontoScope(req.user, sql`e`)}
    `;
    // Bank transactions of the month (both signs) + actual income rows (pay slips)
    // — the evidence for income plans. Expense plans match invoices + bank debits;
    // income plans match income rows + bank credits.
    const banktx = await sql`
      SELECT bt.id, bt.booking_date::text AS datum, bt.counterparty, bt.description, bt.amount::float8 AS amount
      FROM bank_tx bt
      WHERE bt.booking_date BETWEEN ${b.first} AND ${b.last}
    `;
    const income = await sql`
      SELECT i.id, i.datum::text AS datum, i.amount::float8 AS amount, i.source, i.description,
             i.konto_id, k.name AS konto_name, k.is_shared, u.username AS owner
      FROM income i
      LEFT JOIN konto k ON k.id = i.konto_id
      LEFT JOIN users u ON u.id = k.user_id
      WHERE i.datum BETWEEN ${b.first} AND ${b.last}
      ORDER BY i.amount DESC, i.id DESC`;
    const bankText = (cp: unknown, desc: unknown): string | null => [cp, desc].filter(Boolean).join(' ') || null;

    // Two evidence pools; a candidate is keyed "<source>:<id>" so one piece of
    // evidence never serves two positions and a confirmed one is never re-suggested.
    type Ev = { source: 'receipt' | 'bank' | 'income'; id: number; laden: string | null; betrag: number; datum: string };
    const evExpense: Ev[] = [
      ...receipts.map(r => ({ source: 'receipt' as const, id: r.id as number, laden: r.roh_ladenname as string | null, betrag: r.gesamt_betrag as number, datum: String(r.datum) })),
      ...banktx.filter(bt => (bt.amount as number) < 0).map(bt => ({ source: 'bank' as const, id: bt.id as number, laden: bankText(bt.counterparty, bt.description), betrag: Math.abs(bt.amount as number), datum: String(bt.datum) })),
    ];
    const evIncome: Ev[] = [
      ...income.map(i => ({ source: 'income' as const, id: i.id as number, laden: i.description as string | null, betrag: i.amount as number, datum: String(i.datum) })),
      ...banktx.filter(bt => (bt.amount as number) > 0).map(bt => ({ source: 'bank' as const, id: bt.id as number, laden: bankText(bt.counterparty, bt.description), betrag: bt.amount as number, datum: String(bt.datum) })),
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

    // Deterministic suggestion: merchant match (learned match_merchant, else label
    // tokens) and/or amount within ±max(1 €, 2 %). Greedy: best score first, one
    // piece of evidence serves at most one position.
    type Cand = { fixedId: number; source: 'receipt' | 'bank' | 'income'; einkaufId: number | null; bankTxId: number | null; incomeId: number | null; score: number; laden: string | null; betrag: number; datum: string; amountOk: boolean; merchantOk: boolean };
    const cands: Cand[] = [];
    for (const f of fixed) {
      if (f.check_id || f.expect_receipt === false) continue;
      const pool = f.kind === 'income' ? evIncome : evExpense;
      const target = f.monthly_eur as number;
      const tol = Math.max(1, Math.abs(target) * 0.02);
      const needle = normMerchant((f.match_merchant as string | null) ?? '');
      const labelToks = normMerchant(f.label as string).split(' ').filter(w => w.length >= 4);
      for (const ev of pool) {
        const key = `${ev.source}:${ev.id}`;
        if (usedKeys.has(key) || confirmedElsewhere.has(key)) continue;
        const laden = normMerchant(ev.laden ?? '');
        const amountOk = Math.abs(ev.betrag - target) <= tol;
        const merchantOk = !!(needle && laden.includes(needle)) || labelToks.some(tk => laden.includes(tk));
        if (!amountOk && !merchantOk) continue;
        cands.push({
          fixedId: f.id as number, source: ev.source,
          einkaufId: ev.source === 'receipt' ? ev.id : null, bankTxId: ev.source === 'bank' ? ev.id : null, incomeId: ev.source === 'income' ? ev.id : null,
          score: (merchantOk ? 2 : 0) + (amountOk ? 1 : 0) + (needle && laden.includes(needle) ? 1 : 0),
          laden: ev.laden, betrag: ev.betrag, datum: ev.datum, amountOk, merchantOk,
        });
      }
    }
    cands.sort((a, c) => c.score - a.score);
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
    const prevFirst = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 - 3, 1)).toISOString().slice(0, 10);
    const sums = await sql`
      SELECT bu.id AS budget_id, date_trunc('month', e.datum)::date::text AS mon, SUM(a.preis)::float8 AS total
      FROM budget bu
      JOIN budget_category bc ON bc.budget_id = bu.id
      JOIN artikel a ON a.preis IS NOT NULL AND a.category_path IS NOT NULL
        AND (a.category_path = bc.category_path OR a.category_path LIKE bc.category_path || '/%')
      JOIN einkauf e ON e.id = a.einkauf_id
      WHERE bu.active AND e.datum BETWEEN ${prevFirst} AND ${b.last}
        AND (bu.konto_id IS NULL OR e.konto_id = bu.konto_id)
        AND NOT EXISTS (SELECT 1 FROM fixed_cost_check fc WHERE fc.einkauf_id = e.id)
      GROUP BY bu.id, date_trunc('month', e.datum)
    `;
    // NB: no kontoScope here on purpose — a private receipt still counts toward the
    // (shared) budget total; the drill-down masks its details for non-owners. The
    // budget Ist is a household aggregate, so the amount is visible to everyone.
    // NB: an artikel matching two category prefixes of the SAME budget would double-
    // count — the UI prevents nesting by keeping picks distinct; acceptable for v1.
    const actualBy = new Map<number, number>();
    const histBy = new Map<number, number[]>();
    for (const s of sums) {
      const mon = String(s.mon);
      if (mon === b.first) actualBy.set(s.budget_id as number, s.total as number);
      else {
        const arr = histBy.get(s.budget_id as number) ?? [];
        arr.push(s.total as number);
        histBy.set(s.budget_id as number, arr);
      }
    }
    const median = (xs: number[]): number | null => {
      if (!xs.length) return null;
      const s = [...xs].sort((a, c) => a - c);
      return Math.round(s[Math.floor((s.length - 1) / 2)] * 100) / 100;
    };

    // Map a plan row (expense or income) to its month-view shape (check + suggestion).
    const mapPlan = (f: typeof fixed[number]) => ({
      id: f.id, label: f.label, monthly_eur: f.monthly_eur, kind: f.kind, frequency: f.frequency, is_transfer: f.is_transfer, expect_receipt: f.expect_receipt,
      match_merchant: f.match_merchant, konto_id: f.konto_id, konto_name: f.konto_name,
      is_shared: f.is_shared, owner: f.owner,
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
      // actual income entries of the month (pay slips) — shown as the summary total
      income: income.map(i => ({
        id: i.id, datum: String(i.datum), amount: i.amount, source: i.source, description: i.description,
        konto_id: i.konto_id, konto_name: i.konto_name, is_shared: i.is_shared, owner: i.owner,
      })),
      // recurring income PLANS (Einnahmen-Soll), matched vs actual income/bank credits
      incomes: fixed.filter(f => f.kind === 'income').map(mapPlan),
      fixed: fixed.filter(f => f.kind !== 'income').map(mapPlan),
      budgets: budgets.map(bu => ({
        id: bu.id, label: bu.label, monthly_target: bu.monthly_target, konto_id: bu.konto_id,
        konto_name: bu.konto_name, is_shared: bu.is_shared, owner: bu.owner,
        categories: bu.categories,
        actual: Math.round(((actualBy.get(bu.id as number) ?? 0)) * 100) / 100,
        forecast: median(histBy.get(bu.id as number) ?? []),
      })),
    };
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
    let incomeId: number | null = null;
    let amount: number | null = null;
    if (bdy.action === 'confirm' && bdy.income_id) {
      // An actual income row (pay slip) as evidence for an income plan.
      const [inc] = await sql`SELECT id, amount::float8 AS amount, description FROM income WHERE id = ${bdy.income_id}`;
      if (!inc) return reply.code(404).send({ error: 'income not found' });
      incomeId = inc.id as number;
      amount = inc.amount as number | null;
      const merchant = ((inc.description as string | null) ?? '').trim();
      if (!f.match_merchant && merchant) await sql`UPDATE fixed_cost SET match_merchant = ${merchant} WHERE id = ${fixedId}`;
    } else if (bdy.action === 'confirm' && bdy.einkauf_id) {
      const [e] = await sql`
        SELECT e.id, e.gesamt_betrag::float8 AS betrag, e.roh_ladenname, e.quelle FROM einkauf e
        WHERE e.id = ${bdy.einkauf_id} ${kontoScope(req.user, sql`e`)}`;
      if (!e) return reply.code(404).send({ error: 'receipt not found' });
      // Guard: a fixed cost can only be backed by an invoice (e-mail or dropped
      // PDF), never a till/cash receipt — even if the client somehow passes one.
      if (e.quelle !== 'email' && e.quelle !== 'upload') return reply.code(400).send({ error: 'fixed costs can only be matched to invoices, not till receipts' });
      einkaufId = e.id as number;
      amount = e.betrag as number | null;
      // Learn the merchant for future auto-suggestions ("Internet" ↔ "Telekom").
      if (!f.match_merchant && e.roh_ladenname) {
        await sql`UPDATE fixed_cost SET match_merchant = ${(e.roh_ladenname as string).trim()} WHERE id = ${fixedId}`;
      }
    } else if (bdy.action === 'confirm' && bdy.bank_tx_id) {
      // A bank transaction as evidence (comdirect CSV etc.). Amount is the paid
      // amount (abs of the Belastung); learn the merchant from the counterparty.
      const [bt] = await sql`SELECT id, amount::float8 AS amount, counterparty, description FROM bank_tx WHERE id = ${bdy.bank_tx_id}`;
      if (!bt) return reply.code(404).send({ error: 'bank transaction not found' });
      bankTxId = bt.id as number;
      amount = Math.abs(bt.amount as number);
      const merchant = ((bt.counterparty as string | null) ?? '').trim() || ((bt.description as string | null) ?? '').trim();
      if (!f.match_merchant && merchant) {
        await sql`UPDATE fixed_cost SET match_merchant = ${merchant} WHERE id = ${fixedId}`;
      }
    }
    await sql`
      INSERT INTO fixed_cost_check (fixed_cost_id, month, status, einkauf_id, bank_tx_id, income_id, amount, decided_by)
      VALUES (${fixedId}, ${checkMonth}, ${bdy.action === 'skip' ? 'skipped' : 'confirmed'}, ${einkaufId}, ${bankTxId}, ${incomeId}, ${amount}, ${req.user?.id ?? null})
      ON CONFLICT (fixed_cost_id, month) DO UPDATE SET
        status = EXCLUDED.status, einkauf_id = EXCLUDED.einkauf_id, bank_tx_id = EXCLUDED.bank_tx_id,
        income_id = EXCLUDED.income_id, amount = EXCLUDED.amount, decided_by = EXCLUDED.decided_by, decided_at = NOW()`;
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
             (SELECT fm.name FROM family_member fm WHERE fm.user_id = k.user_id ORDER BY fm.sort_order, fm.id LIMIT 1) AS owner_name
      FROM income i
      LEFT JOIN konto k ON k.id = i.konto_id
      LEFT JOIN users u ON u.id = k.user_id
      ${b ? sql`WHERE i.datum BETWEEN ${b.first} AND ${b.last}` : sql``}
      ORDER BY i.datum DESC, i.id DESC`;
    return { income: rows };
  });

  /** Income-evidence candidates of a month for the manual picker on an income plan:
   *  actual income rows (pay slips) + bank credits (Gutschriften, amount > 0). */
  app.get('/api/finances/income-evidence', async (req, reply) => {
    const b = monthBounds(((req.query as { month?: string }).month ?? '').trim());
    if (!b) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    const inc = await sql`SELECT id, datum::text AS datum, amount::float8 AS amount, description FROM income WHERE datum BETWEEN ${b.first} AND ${b.last} ORDER BY datum DESC, id DESC`;
    const bank = await sql`SELECT id, booking_date::text AS datum, amount::float8 AS amount, counterparty, description FROM bank_tx WHERE booking_date BETWEEN ${b.first} AND ${b.last} AND amount > 0 ORDER BY booking_date DESC`;
    return {
      items: [
        ...inc.map(i => ({ source: 'income' as const, id: i.id, datum: String(i.datum), amount: i.amount, label: (i.description as string | null) || 'Einnahme' })),
        ...bank.map(bt => ({ source: 'bank' as const, id: bt.id, datum: String(bt.datum), amount: bt.amount, label: [bt.counterparty, bt.description].filter(Boolean).join(' ') || 'Gutschrift' })),
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
    return {
      ok: true, income_id: row.id, filename: bdy.filename ?? null,
      datum, netto: ex.netto, brutto: ex.brutto, monat: ex.monat, arbeitgeber: ex.arbeitgeber,
    };
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
    const b = monthBounds(((req.query as { month?: string }).month ?? '').trim());
    if (!b) return reply.code(400).send({ error: 'month must be YYYY-MM' });
    const rows = await sql`
      SELECT a.id, COALESCE(NULLIF(a.canonical_name, ''), a.name) AS name,
             a.preis::float8 AS preis, a.menge::float8 AS menge, a.einheit, a.category_path,
             e.id AS einkauf_id, e.datum::text AS datum, e.roh_ladenname AS laden,
             e.private_for_user_id
      FROM budget bu
      JOIN budget_category bc ON bc.budget_id = bu.id
      JOIN artikel a ON a.preis IS NOT NULL AND a.category_path IS NOT NULL
        AND (a.category_path = bc.category_path OR a.category_path LIKE bc.category_path || '/%')
      JOIN einkauf e ON e.id = a.einkauf_id
      WHERE bu.id = ${id} AND bu.active AND e.datum BETWEEN ${b.first} AND ${b.last}
        AND (bu.konto_id IS NULL OR e.konto_id = bu.konto_id)
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
