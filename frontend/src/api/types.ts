export interface User {
  id: number;
  username: string;
  email?: string | null;
  is_admin: boolean;
  sees_all_konten?: boolean;
  can_write?: boolean;
  pinned_chains?: string[];
  prefers_dark: boolean;
  preferred_lang: string;
  emoji?: string | null;
  has_seen_tour?: boolean;
  created_at?: string;
  invite_pending?: boolean;
  invite_expired?: boolean;
}

export interface Receipt {
  id: number;
  datum: string;
  roh_ladenname: string | null;
  bild_pfad: string | null;
  gesamt_betrag: string | null;
  geprueft?: boolean;
  konto_id?: number | null;
  konto_name?: string | null;
  quelle?: string;
  item_count?: number;
  private?: boolean;
  ocr_pending?: boolean;
  date_uncertain?: boolean;
  has_email?: boolean;
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
  consumers: number[];
  consumers_exclusive: boolean;
  consumers_source: 'artikel' | 'canonical' | 'none';
}

export interface ReceiptDetail extends Receipt {
  artikel: Artikel[];
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
  user_id: number | null;
  sort_order: number;
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
  ai_guess: string | null;
  einkauf_id: number | null;
  sample_artikel_id: number | null;
  suggestion: string | null;
  confidence: string | null;
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
