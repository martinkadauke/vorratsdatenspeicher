import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { kontoScope } from '../auth/konto.js';

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
      SELECT f.id, f.label, f.category_path, f.monthly_eur::float8 AS monthly_eur,
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
    const [row] = await sql`
      INSERT INTO fixed_cost (label, category_path, monthly_eur, konto_id, start_date, end_date, active, expect_receipt, match_merchant, created_by)
      VALUES (${label}, ${category}, ${monthly}, ${kontoId}, ${start}, ${end}, ${b.active !== false},
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

  /** Everything the month view needs: fixed-cost checklist (state + suggestion)
   *  and budget rows (forecast / target / actual). Matching is deliberately a
   *  self-contained, deterministic step here — when bank-CSV transactions arrive
   *  as a second evidence source, they slot in as additional candidates. */
  app.get('/api/finances/month', async (req, reply) => {
    const m = ((req.query as { month?: string }).month ?? '').trim();
    const b = monthBounds(m);
    if (!b) return reply.code(400).send({ error: 'month must be YYYY-MM' });

    // 1) Fixed costs active in this month + their check (if decided).
    const fixed = await sql`
      SELECT f.id, f.label, f.monthly_eur::float8 AS monthly_eur, f.expect_receipt, f.match_merchant,
             f.konto_id, k.name AS konto_name, k.is_shared, u.username AS owner,
             c.id AS check_id, c.status AS check_status, c.einkauf_id AS check_einkauf_id,
             c.amount::float8 AS check_amount,
             ce.roh_ladenname AS check_laden, ce.datum::text AS check_datum
      FROM fixed_cost f
      LEFT JOIN konto k ON k.id = f.konto_id
      LEFT JOIN users u ON u.id = k.user_id
      LEFT JOIN fixed_cost_check c ON c.fixed_cost_id = f.id AND c.month = ${b.first}
      LEFT JOIN einkauf ce ON ce.id = c.einkauf_id
      WHERE f.active AND f.start_date <= ${b.last} AND (f.end_date IS NULL OR f.end_date >= ${b.first})
      ORDER BY k.is_shared DESC NULLS LAST, u.username NULLS FIRST, f.label
    `;

    // 2) Candidate receipts of the month (visibility-scoped) for suggestion matching.
    const receipts = await sql`
      SELECT e.id, e.datum::text AS datum, e.roh_ladenname, e.gesamt_betrag::float8 AS gesamt_betrag
      FROM einkauf e
      WHERE e.datum BETWEEN ${b.first} AND ${b.last} AND e.gesamt_betrag IS NOT NULL
        ${kontoScope(req.user, sql`e`)}
    `;
    const usedByCheck = new Set(fixed.map(f => f.check_einkauf_id as number | null).filter(Boolean));
    // Receipts already confirmed for ANY month/position never get re-suggested.
    const confirmedElsewhere = new Set(
      (await sql`SELECT einkauf_id FROM fixed_cost_check WHERE einkauf_id IS NOT NULL`).map(r => r.einkauf_id as number),
    );

    // Deterministic suggestion: merchant match (learned match_merchant, else label
    // tokens) and/or amount within ±max(1 €, 2 %). Greedy: best score first, one
    // receipt serves at most one position.
    type Cand = { fixedId: number; einkaufId: number; score: number; laden: string | null; betrag: number; datum: string; amountOk: boolean; merchantOk: boolean };
    const cands: Cand[] = [];
    for (const f of fixed) {
      if (f.check_id || f.expect_receipt === false) continue;
      const target = f.monthly_eur as number;
      const tol = Math.max(1, Math.abs(target) * 0.02);
      const needle = normMerchant((f.match_merchant as string | null) ?? '');
      const labelToks = normMerchant(f.label as string).split(' ').filter(w => w.length >= 4);
      for (const r of receipts) {
        if (usedByCheck.has(r.id as number) || confirmedElsewhere.has(r.id as number)) continue;
        const laden = normMerchant((r.roh_ladenname as string | null) ?? '');
        const amountOk = Math.abs((r.gesamt_betrag as number) - target) <= tol;
        const merchantOk = !!(needle && laden.includes(needle)) || labelToks.some(tk => laden.includes(tk));
        if (!amountOk && !merchantOk) continue;
        cands.push({
          fixedId: f.id as number, einkaufId: r.id as number,
          score: (merchantOk ? 2 : 0) + (amountOk ? 1 : 0) + (needle && laden.includes(needle) ? 1 : 0),
          laden: r.roh_ladenname as string | null, betrag: r.gesamt_betrag as number,
          datum: String(r.datum), amountOk, merchantOk,
        });
      }
    }
    cands.sort((a, c) => c.score - a.score);
    const sugByFixed = new Map<number, Cand>();
    const takenReceipts = new Set<number>();
    for (const c of cands) {
      if (sugByFixed.has(c.fixedId) || takenReceipts.has(c.einkaufId)) continue;
      sugByFixed.set(c.fixedId, c);
      takenReceipts.add(c.einkaufId);
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
      WHERE bu.active
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
        ${kontoScope(req.user, sql`e`)}
      GROUP BY bu.id, date_trunc('month', e.datum)
    `;
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

    return {
      month: m,
      fixed: fixed.map(f => ({
        id: f.id, label: f.label, monthly_eur: f.monthly_eur, expect_receipt: f.expect_receipt,
        match_merchant: f.match_merchant, konto_id: f.konto_id, konto_name: f.konto_name,
        is_shared: f.is_shared, owner: f.owner,
        check: f.check_id ? {
          status: f.check_status, einkauf_id: f.check_einkauf_id, amount: f.check_amount,
          laden: f.check_laden, datum: f.check_datum ? String(f.check_datum) : null,
        } : null,
        suggestion: sugByFixed.has(f.id as number) ? (() => {
          const s = sugByFixed.get(f.id as number)!;
          return { einkauf_id: s.einkaufId, laden: s.laden, betrag: s.betrag, datum: s.datum, amount_ok: s.amountOk, merchant_ok: s.merchantOk };
        })() : null,
      })),
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
    const bdy = (req.body ?? {}) as { fixed_cost_id?: number; month?: string; action?: string; einkauf_id?: number | null };
    const fixedId = parseInt(String(bdy.fixed_cost_id ?? ''), 10);
    const bounds = monthBounds((bdy.month ?? '').trim());
    if (!fixedId || !bounds) return reply.code(400).send({ error: 'fixed_cost_id and month (YYYY-MM) required' });
    const [f] = await sql`SELECT id, match_merchant FROM fixed_cost WHERE id = ${fixedId}`;
    if (!f) return reply.code(404).send({ error: 'fixed cost not found' });

    if (bdy.action === 'clear') {
      await sql`DELETE FROM fixed_cost_check WHERE fixed_cost_id = ${fixedId} AND month = ${bounds.first}`;
      return { ok: true };
    }
    if (bdy.action !== 'confirm' && bdy.action !== 'skip') return reply.code(400).send({ error: 'bad action' });

    let einkaufId: number | null = null;
    let amount: number | null = null;
    if (bdy.action === 'confirm' && bdy.einkauf_id) {
      const [e] = await sql`
        SELECT e.id, e.gesamt_betrag::float8 AS betrag, e.roh_ladenname FROM einkauf e
        WHERE e.id = ${bdy.einkauf_id} ${kontoScope(req.user, sql`e`)}`;
      if (!e) return reply.code(404).send({ error: 'receipt not found' });
      einkaufId = e.id as number;
      amount = e.betrag as number | null;
      // Learn the merchant for future auto-suggestions ("Internet" ↔ "Telekom").
      if (!f.match_merchant && e.roh_ladenname) {
        await sql`UPDATE fixed_cost SET match_merchant = ${(e.roh_ladenname as string).trim()} WHERE id = ${fixedId}`;
      }
    }
    await sql`
      INSERT INTO fixed_cost_check (fixed_cost_id, month, status, einkauf_id, amount, decided_by)
      VALUES (${fixedId}, ${bounds.first}, ${bdy.action === 'skip' ? 'skipped' : 'confirmed'}, ${einkaufId}, ${amount}, ${req.user?.id ?? null})
      ON CONFLICT (fixed_cost_id, month) DO UPDATE SET
        status = EXCLUDED.status, einkauf_id = EXCLUDED.einkauf_id, amount = EXCLUDED.amount,
        decided_by = EXCLUDED.decided_by, decided_at = NOW()`;
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
}
