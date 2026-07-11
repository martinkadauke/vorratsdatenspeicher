import type { FastifyInstance } from 'fastify';
import sql from '../db.js';
import { requireAdmin } from '../auth/plugin.js';
import { kontoScope } from '../auth/konto.js';

// The nature of a payment account. Only 'giro' & 'kreditkarte' have importable bank
// statements → a receipt on those needs a linked bank booking to be complete; the rest
// (cash / crypto / securities / PayPal) never do. Keep in sync with the frontend list.
export const ACCOUNT_TYPES = ['giro', 'kreditkarte', 'paypal', 'bargeld', 'krypto', 'depot'] as const;
type AccountType = typeof ACCOUNT_TYPES[number];
const normType = (v: unknown): AccountType => (ACCOUNT_TYPES as readonly string[]).includes(String(v)) ? String(v) as AccountType : 'giro';

// Only these account types have importable bank statements (comdirect-style CSV), so a
// receipt on one of them needs a linked bank booking to be complete.
export const STATEMENT_ACCOUNT_TYPES: readonly string[] = ['giro', 'kreditkarte'];
export const accountHasStatements = (t: string | null | undefined): boolean => STATEMENT_ACCOUNT_TYPES.includes(String(t ?? ''));

export function kontoRoutes(app: FastifyInstance): void {
  /** Accounts the current user may see (for selectors / move-to-list).
   *  Includes the user-visible receipt count so the overview can hide
   *  empty accounts from its filter chips. */
  app.get('/api/konten', async (req) => {
    // Whole-account hiding is gone: every account is visible to every user. Only
    // individual receipts can be private (the per-account count excludes others'
    // private receipts via kontoScope).
    return sql`
      SELECT k.id, k.name, k.is_shared, k.is_cash, k.payment_type, k.account_type, k.user_id, u.username AS owner,
             (SELECT fm.name FROM family_member fm WHERE fm.user_id = k.user_id ORDER BY fm.sort_order, fm.id LIMIT 1) AS owner_name,
             (SELECT COUNT(*)::int FROM einkauf e
              WHERE e.konto_id = k.id ${kontoScope(req.user, sql`e`)}) AS receipts
      FROM konto k LEFT JOIN users u ON u.id = k.user_id
      ORDER BY k.is_shared DESC, k.is_cash, k.sort_order, k.name
    `;
  });

  /** Full account list (admin) with receipt counts. */
  app.get('/api/admin/konten', { preHandler: requireAdmin }, async (req) => {
    return sql`
      SELECT k.id, k.name, k.is_shared, k.is_cash, k.account_type, k.user_id, u.username AS owner, k.sort_order,
             (SELECT COUNT(*)::int FROM einkauf e
              WHERE e.konto_id = k.id ${kontoScope(req.user, sql`e`)}) AS receipts
      FROM konto k LEFT JOIN users u ON u.id = k.user_id
      ORDER BY k.is_shared DESC, k.sort_order, k.name
    `;
  });

  app.post('/api/admin/konten', { preHandler: requireAdmin }, async (req, reply) => {
    const { name, is_shared, user_id, account_type } = (req.body ?? {}) as { name?: string; is_shared?: boolean; user_id?: number | null; account_type?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'name required' });
    const at = normType(account_type);
    const [row] = await sql`
      INSERT INTO konto (name, is_shared, user_id, account_type, is_cash)
      VALUES (${name.trim()}, ${is_shared ?? false}, ${user_id ?? null}, ${at}, ${at === 'bargeld'})
      RETURNING id
    `;
    return { ok: true, id: row.id };
  });

  app.patch('/api/admin/konten/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const body = (req.body ?? {}) as { name?: string; is_shared?: boolean; user_id?: number | null; sort_order?: number; account_type?: string };
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.is_shared !== undefined) updates.is_shared = body.is_shared;
    if ('user_id' in body) updates.user_id = body.user_id ?? null;
    // account_type also drives is_cash (cash accounts are excluded from bank scopes /
    // the card picker), so keep the two in lockstep.
    if ('account_type' in body) { const at = normType(body.account_type); updates.account_type = at; updates.is_cash = at === 'bargeld'; }
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order;
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'nothing to update' });
    const rows = await sql`UPDATE konto SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.delete('/api/admin/konten/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseInt((req.params as { id: string }).id, 10);
    const [used] = await sql`SELECT COUNT(*)::int AS n FROM einkauf WHERE konto_id = ${id}`;
    if (used.n > 0) return reply.code(409).send({ error: `account has ${used.n} receipts — move them first` });
    const [shared] = await sql`SELECT is_shared FROM konto WHERE id = ${id}`;
    if (shared?.is_shared) return reply.code(409).send({ error: 'cannot delete the shared account' });
    await sql`DELETE FROM konto WHERE id = ${id}`;
    return { ok: true };
  });
}
