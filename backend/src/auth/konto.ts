import sql from '../db.js';
import type { User } from '../types.js';

type Frag = ReturnType<typeof sql>;

/** Returns a SQL fragment that scopes a query to the accounts a user may see.
 *  Pass the (table-qualified) konto_id column as a sql fragment, e.g.
 *    sql`SELECT … WHERE TRUE ${kontoScope(req.user, sql`e.konto_id`)}`
 *  - super-admins (sees_all_konten): no filter
 *  - everyone else: konto_id ∈ visible ids, plus un-assigned (NULL = GKK-like)
 *  - a user with no visible accounts: matches nothing
 */
export function kontoScope(user: User | undefined, col: Frag): Frag {
  if (!user || user.sees_all_konten) return sql``;
  const ids = user.konto_ids ?? [];
  if (!ids.length) return sql`AND FALSE`;
  return sql`AND (${col} IN ${sql(ids)} OR ${col} IS NULL)`;
}

/** True if the user is allowed to see a given receipt's account. */
export function canSeeKonto(user: User | undefined, kontoId: number | null): boolean {
  if (!user || user.sees_all_konten) return true;
  if (kontoId === null) return true; // un-assigned = GKK-like
  return (user.konto_ids ?? []).includes(kontoId);
}
