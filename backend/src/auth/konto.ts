import sql from '../db.js';
import type { User } from '../types.js';

type Frag = ReturnType<typeof sql>;

/** Visibility filter — per-RECEIPT privacy (this replaced whole-account hiding).
 *  Pass the einkauf (or v_transactions) table ALIAS as a sql fragment, e.g.
 *    sql`SELECT … FROM einkauf e WHERE TRUE ${kontoScope(req.user, sql`e`)}`
 *  Emits: AND (<e>.private_for_user_id IS NULL OR <e>.private_for_user_id = <uid>)
 *  - private_for_user_id NULL  → SHARED, visible to everyone who can use the app
 *  - private_for_user_id set   → visible ONLY to that user AND to super-admins
 *    (sees_all_konten = "kann alles sehen" → literally everything, no exception)
 *  - super-admin (sees_all_konten) → NO filter at all
 *  - undefined user (internal/unauthenticated call) → no filter
 *
 *  NOTE: takes the table ALIAS, not the konto_id column — a call site that still
 *  passes `e.konto_id` produces invalid SQL (`e.konto_id.private_for_user_id`) and
 *  fails loudly, rather than silently leaking. */
export function kontoScope(user: User | undefined, alias: Frag): Frag {
  if (!user || user.sees_all_konten) return sql``;
  return sql`AND (${alias}.private_for_user_id IS NULL OR ${alias}.private_for_user_id = ${user.id})`;
}

/** Whole-account hiding is gone — every account is visible to every user; only
 *  individual receipts can be private. So a receipt may be moved to any account. */
export function canSeeKonto(_user: User | undefined, _kontoId: number | null): boolean {
  return true;
}
