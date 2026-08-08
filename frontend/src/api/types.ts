export interface User {
  id: number;
  username: string;
  email?: string | null;
  is_admin: boolean;
  is_super_admin?: boolean;
  household_id?: number;
  sees_all_konten?: boolean;
  can_write?: boolean;
  pinned_chains?: string[];
  prefers_dark: boolean;
  preferred_lang: string;
  emoji?: string | null;
  has_seen_tour?: boolean;
  has_seen_email_tutorial?: boolean;
  /** Demo build only: has this household ever scanned a receipt itself (household.ocr_count > 0)?
   *  Drives the first-run example-receipt preload in CreatePurchaseModal. Always undefined
   *  off-demo — the counter column only exists in the demo schema. */
  demo_scanned?: boolean;
  onboarding_done?: boolean;
  created_at?: string;
  invite_pending?: boolean;
  invite_expired?: boolean;
}

// Account nature. Only these two have importable bank statements → a receipt on such
// an account needs a linked bank booking to count as complete. Keep in sync with the
// backend ACCOUNT_TYPES (backend/src/routes/konten.ts).
export const ACCOUNT_TYPES = ['giro', 'kreditkarte', 'paypal', 'bargeld', 'krypto', 'depot'] as const;
export type AccountType = typeof ACCOUNT_TYPES[number];
export const STATEMENT_TYPES: readonly AccountType[] = ['giro', 'kreditkarte'];
export const accountHasStatements = (t: string | null | undefined): boolean => STATEMENT_TYPES.includes((t ?? '') as AccountType);

export interface Receipt {
  id: number;
  datum: string;
  roh_ladenname: string | null;
  bild_pfad: string | null;
  gesamt_betrag: string | null;
  geprueft?: boolean;
  konto_id?: number | null;
  konto_name?: string | null;
  account_type?: string | null;
  quelle?: string;
  item_count?: number;
  refund_total?: number;   // Σ of refund positions (≤ 0); receipt net = gesamt_betrag + refund_total
  private?: boolean;
  ocr_pending?: boolean;
  date_uncertain?: boolean;
  has_email?: boolean;
  has_refund_email?: boolean;   // a refund mail is attached (paperclip)
}

/** A candidate ORIGINAL receipt a refund can be booked onto, with its positions
 *  (menge/einheit carried so the reconciliation dialog can split a combined line). */
export interface RefundCandidatePosition {
  id: number; name: string; preis: number | null; menge: number | null; einheit: string | null;
}
export interface RefundCandidate {
  id: number; datum: string; roh_ladenname: string | null;
  gesamt_betrag: number | null; konto_name: string | null;
  positions: RefundCandidatePosition[];
  already_refunded?: boolean;   // (bank flow) receipt already carries a booked refund ~this amount → link, don't re-book
}
/** What the reconciliation dialog sends to whichever refund endpoint booked it. */
export interface RefundBookPayload {
  einkauf_id: number;
  discount_only: boolean;
  amount: number;
  description?: string;
  lines?: { artikel_id: number; return_qty: number }[];
}

export interface Konto {
  id: number;
  name: string;
  is_shared: boolean;
  user_id: number | null;
  owner?: string | null;
  receipts?: number;
  sort_order?: number;
}

export interface Artikel {
  id: number;
  name: string | null;
  menge: string | null;
  einheit: string | null;
  preis: string | null;
  original_text: string | null;
  ai_guess: string | null;
  canonical_name: string | null;
  category_path: string | null;
  user_corrected?: boolean;
  is_refund?: boolean;
  refund_for_artikel_id?: number | null;
  consumers: number[];
  consumers_exclusive: boolean;
  consumers_source: 'artikel' | 'canonical' | 'none';
}

export interface ReceiptDetail extends Receipt {
  artikel: Artikel[];
  /** Matched comdirect bank transaction — the PRIMARY, if any (back-compat). */
  bank?: { id: number; booking_date: string; amount: number; counterparty: string | null } | null;
  /** ALL matched bank bookings (primary + split siblings, e.g. an Amazon order paid per shipment). */
  banks?: { id: number; booking_date: string; amount: number; counterparty: string | null }[];
  /** Household member who scanned/uploaded this receipt (family_member id). */
  snapped_by_member_id?: number | null;
  /** True when this receipt's account has bank statements (Giro/Kreditkarte) AND some are
   *  imported — i.e. a bank booking must be linked before it can be marked complete. */
  bank_expected?: boolean;
}

/** A single line item ("Position") — one artikel row joined with its receipt's
 *  date/store. Distinct from a canonical product (Artikel) and a receipt (Beleg). */
export interface Position {
  id: number;                       // artikel id
  name: string;
  canonical_name: string | null;
  menge: string | number | null;
  einheit: string | null;
  preis: string | null;
  category_path: string | null;
  einkauf_id: number;
  datum: string;
  roh_ladenname: string | null;
  quelle?: string;
  konto_id?: number | null;
  konto_name?: string | null;
  private?: boolean;
}

export interface Category {
  id: number;
  path: string;
  parent_path: string | null;
  display: string;
  display_en: string | null;
  label: string;
  level: number;
  sort_order: number;
  emoji: string | null;
  is_meta: boolean;
}

export interface FamilyMember {
  id: number;
  name: string;
  color: string | null;
  emoji: string | null;
  /** The login this person uses, if they have one at all — children and pets do not. */
  user_id: number | null;
  username?: string | null;
  sort_order: number;
  /** Set once someone leaves the household: hidden from every picker, history untouched. */
  archived_at?: string | null;
  /** Bank accounts this person owns (n:m — a joint account lists several owners). */
  konto_ids?: number[];
}

export interface SpendingNode {
  path: string;
  parent_path?: string | null;
  label: string;
  emoji?: string | null;
  level: number;
  sort_order?: number;
  mtd: number;
  projection: number;
  avg3: number;
  goal: number | null;
}

export interface SpendingTree {
  year: number;
  month: number;
  is_current_month: boolean;
  days_elapsed: number;
  days_total: number;
  total: SpendingNode;
  nodes: SpendingNode[];
}

export interface CanonicalName {
  canonical_name: string;
  artikel_count: number;
  category_path: string | null;
  base_unit?: string | null;
  expected_price?: number | null;
  track_vorrat?: boolean | null;
  last_bought: string | null;
  weekly_consumption?: number | null;
  consumption_unit?: string | null;
  translation_en: string | null;
  consumers: number[];
  consumers_exclusive: boolean;
  user_corrected?: boolean;   // a human set/confirmed the canonical name
  needs_weight?: boolean;     // base_unit is kg/l but no purchase carries a weight → no €/kg
}

export interface QueueItem {
  id: number;
  proposed_canonical: string | null;
  raw_patterns: string | null;
  ai_examples: string | null;
  confidence: string | null;
  status: string;
  created_at: string;
  artikel_id: number | null;
  einkauf_id: number | null;
}

/** One article-driven Prüfen review row: all articles sharing an OCR key that still
 *  need a human decision, with the churner's pending proposal as a pre-fill. */
export interface PruefenGroup {
  grp: string;
  ocr_key: string | null;
  artikel_ids: number[];
  occurrences: number;
  original_text: string | null;
  name: string | null;
  ai_guess: string | null;
  einkauf_id: number | null;
  sample_artikel_id: number | null;
  suggestion: string | null;
  confidence: string | null;
}

/** One unit-review row: a canonical product whose recommended pricing/tracking unit
 *  (from purchase-history variance) differs from the stored base_unit. */
export interface UnitPruefenRow {
  canonical_name: string;
  current_unit: string | null;
  suggested_unit: string;
  kind: string;
  confidence: string;
  rationale: string;
  occurrences: number;
  current_price: number | null;
  suggested_price: number | null;
}

/** A product whose POSITIONS mix units (stk vs Packung vs blank) — Prüfen→Einheiten. */
export interface MixedUnitRow {
  canonical_name: string;
  histogram: { label: string | null; n: number }[]; // null = no unit
  suggested_unit: string;
  lines: number;
}

export interface Notification {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  user_id: number | null;
  created_at: string;
  read_at: string | null;
  acted_at: string | null;
}

export interface PantryItem {
  canonical_name: string;
  base_unit: string | null;
  category: string | null;
  rate_per_day: number | null;
  est_remaining: number | null;
  days_until_empty: number | null;
  last_bought: string | null;
  override: { menge: number; gesetzt_am: string } | null;
  consumption_per_week: number | null; // manual weekly-consumption override (null = auto)
  reserve_min: number | null;
  reserve_total: number;
  reserve_charges: number;
}

export interface ShoppingList {
  id: number;
  name: string;
  store_type: string | null;
  sort: number;
  item_count: number;
}

export interface ShoppingItem {
  id: number;
  canonical_name: string | null;
  title: string;
  menge: number | null;
  einheit: string | null;
  source: string;
  done: boolean;
  priority: number;
  added_by: string | null;
  added_at: string | null;
  comment: string | null;
  avg_price: number | null;
  avg_unit: string | null;
  expected_price: number | null;
  days_until_empty: number | null;
  est_remaining: number | null;
}

export interface MaintenanceEvent {
  id: number;
  kind: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  summary: Record<string, unknown> | null;
}
