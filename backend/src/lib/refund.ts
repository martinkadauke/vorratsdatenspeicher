import sql from '../db.js';

type Frag = ReturnType<typeof sql>;

/** PRODUCT-STATISTICS exclusion for refunds. Pass the artikel table ALIAS as a sql fragment:
 *    sql`SELECT … FROM artikel a … WHERE TRUE ${excludeRefunded(sql`a`)}`
 *  Emits: AND NOT <a>.is_refund AND NOT EXISTS (SELECT 1 FROM artikel r WHERE r.refund_for_artikel_id = <a>.id)
 *
 *  This removes from every product-level surface (Warenstamm count, Ø-price, Vorrat, low-stock
 *  alert, shopping suggestion, offers-due):
 *   1. the negative refund position itself (is_refund), and
 *   2. the ORIGINAL purchase position it refunds (referenced via refund_for_artikel_id) —
 *  so a fully-returned item vanishes from product statistics entirely (no phantom second unit,
 *  no halved average price). It does NOT belong on spend/net surfaces (v_transactions, spending,
 *  budgets, receipt net): there the refund position must count so the negative nets the purchase.
 *
 *  Takes the ALIAS, not a column — a call site passing `a.canonical_name` yields invalid SQL and
 *  fails loudly rather than silently mis-counting. */
export function excludeRefunded(alias: Frag): Frag {
  return sql`AND NOT ${alias}.is_refund AND NOT EXISTS (SELECT 1 FROM artikel _r WHERE _r.refund_for_artikel_id = ${alias}.id)`;
}
