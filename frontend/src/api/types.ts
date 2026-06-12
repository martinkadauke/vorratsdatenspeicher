export interface User {
  id: number;
  username: string;
  email?: string | null;
  is_admin: boolean;
  sees_all_konten?: boolean;
  prefers_dark: boolean;
  preferred_lang: string;
  has_seen_tour?: boolean;
  created_at?: string;
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
  consumers: number[];
  consumers_exclusive: boolean;
  consumers_source: 'artikel' | 'canonical' | 'none';
}

export interface ReceiptDetail extends Receipt {
  artikel: Artikel[];
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
  last_bought: string | null;
  translation_en: string | null;
  consumers: number[];
  consumers_exclusive: boolean;
}

export interface QueueItem {
  id: number;
  proposed_canonical: string | null;
  raw_patterns: string | null;
  ai_examples: string | null;
  confidence: string | null;
  status: string;
  created_at: string;
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
  einheit: string | null;
  avg_daily: string | null;
  last_qty: string | null;
  last_bought: string | null;
  est_remaining: string | null;
  days_until_empty: string | null;
  purchase_count: number | null;
  updated_at: string | null;
}

export interface ShoppingItem {
  canonical_name: string;
  priority: number;
  added_by: string | null;
  added_at: string | null;
  days_until_empty: string | null;
  est_remaining: string | null;
  einheit: string | null;
  last_qty: string | null;
}

export interface MaintenanceEvent {
  id: number;
  kind: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  summary: Record<string, unknown> | null;
}
