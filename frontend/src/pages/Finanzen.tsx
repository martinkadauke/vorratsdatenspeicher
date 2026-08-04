import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wallet, Plus, Pencil, Trash2, Home, User as UserIcon, Info,
  ChevronLeft, ChevronRight, ChevronDown, CheckCircle2, Circle, CircleDot, AlertCircle, Search, X, Upload, Layers, Lock,
  Link2, Link2Off, RefreshCw, Landmark, SlidersHorizontal, Flag, FilePlus2, Receipt, FileText, Paperclip, Sparkles, Calendar, ExternalLink,
  TrendingUp, Archive, Zap, ArrowDownLeft, ArrowUpRight, Undo2, BarChart3, Loader2,
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api, getToken } from '../api/client';
import { Card, Spinner, Button, Input, Label, Select, Switch, Modal, EmptyState, Badge, FeedbackIconButton } from '../components/ui';
import { CategoryPicker } from '../components/CategoryPicker';
import { toast } from '../components/Toast';
import { RefundReconcileDialog } from '../components/RefundReconcileDialog';
import type { RefundCandidate, RefundBookPayload } from '../api/types';
import { confirm } from '../components/Confirm';
// monthNameOf is the shared "Juli 2026" formatter; MonthTab keeps a local `monthLabel`
// string for the header, hence the rename on import.
import { useAuth } from '../context/auth';
import { cn, eur, fmtDate, monthLabel as monthNameOf, todayLocal } from '../lib/utils';
import { useUrlState } from '../hooks/useUrlState';

// ── shared types ────────────────────────────────────────────────────────────

type Freq = 'monthly' | 'quarterly' | 'yearly';
const PERIOD_MONTHS: Record<Freq, number> = { monthly: 1, quarterly: 3, yearly: 12 };
// The per-month burden of a plan: monthly = full amount, quarterly = /3, yearly = /12.
const amortized = (eur: number, freq?: Freq | null) => eur / (PERIOD_MONTHS[(freq ?? 'monthly') as Freq] ?? 1);

interface FixedCost {
  id: number; label: string; category_path: string | null; monthly_eur: number; kind: 'expense' | 'income'; frequency: Freq; is_transfer: boolean;
  konto_id: number | null; start_date: string; end_date: string | null; active: boolean;
  expect_receipt: boolean; match_merchant: string | null; one_off: boolean;
  counterpart_id: number | null; counterpart_label: string | null; counterpart_konto: string | null;
  konto_name: string | null; is_shared: boolean | null; konto_user_id: number | null; owner: string | null;
}
interface KontoLite { id: number; name: string; is_shared: boolean; is_cash: boolean; user_id: number | null; owner: string | null; owner_name: string | null }

interface MonthFix {
  id: number; label: string; monthly_eur: number; kind: 'expense' | 'income'; frequency: Freq; is_transfer: boolean; expect_receipt: boolean; match_merchant: string | null;
  one_off: boolean; counterpart_id: number | null;
  konto_id: number | null; konto_name: string | null; is_shared: boolean | null; owner: string | null;
  complete: boolean; bank_linked: boolean;
  check: { status: 'confirmed' | 'skipped'; source: 'receipt' | 'bank' | 'income' | 'none'; einkauf_id: number | null; bank_tx_id: number | null; income_id: number | null; amount: number | null; laden: string | null; datum: string | null } | null;
  suggestion: { source: 'receipt' | 'bank' | 'income'; einkauf_id: number | null; bank_tx_id: number | null; income_id: number | null; laden: string | null; betrag: number; datum: string; amount_ok: boolean; merchant_ok: boolean } | null;
}
/** A STORED limit. Optional by design: its ABSENCE is what "kein Ziel" means, which is
 *  why monthly_target may be null and why we never fall back to 0 (0,00 would read as
 *  "instantly over budget" on a category nobody ever set a goal for). */
interface BudgetLimit {
  id: number; label: string; monthly_target: number | null; konto_id: number | null;
  konto_name: string | null; is_shared: boolean | null; owner: string | null;
  actual: number;             // € under THIS limit's konto narrowing (= node.actual when konto_id is null)
  forecast: number | null;    // median of the 3 prior months; null = no history
}
/** One node of the DERIVED category tree — always present, limit or not. `actual` is
 *  SUBTREE-INCLUSIVE, so a folded-away level-4 child is still inside its parent's number. */
interface MonthCategoryNode {
  path: string; parent_path: string | null; label: string; emoji: string | null;
  level: number; sort_order: number; is_meta: boolean;
  actual: number; forecast: number | null;
  limit: BudgetLimit | null;      // the limit keyed to this exact path, if any
  extra_limits: BudgetLimit[];    // normally []; duplicates (household-wide + personal) surface here
}
interface MonthCategoryTree { total: MonthCategoryNode; nodes: MonthCategoryNode[] }
/** A budget that deliberately OVERLAPS the tree: several categories and/or single
 *  articles ("Energydrinks" = three canonicals in three different categories). */
interface BudgetLens {
  id: number; label: string; monthly_target: number | null; konto_id: number | null;
  konto_name: string | null; is_shared: boolean | null; owner: string | null;
  categories: string[]; articles: string[]; actual: number; forecast: number | null;
}
/** A stored limit whose category_path is no longer in the catalogue (a category redesign
 *  left it dangling — migration 008 allows exactly that on artikel too). */
interface OrphanLimit {
  id: number; label: string; monthly_target: number | null; konto_id: number | null;
  konto_name: string | null; is_shared: boolean | null; owner: string | null;
  category_path: string; actual: number;
}
interface MonthData {
  month: string; incomes: MonthFix[]; fixed: MonthFix[];
  categoryTree: MonthCategoryTree; lenses: BudgetLens[]; orphanLimits: OrphanLimit[];
  // variableTotal stays the month's TRUE spend (every receipt line counted ONCE) plus
  // one-off costs — never the sum of the (overlapping) budget actuals. The tree, the
  // buckets and this number satisfy:
  //   variableTotal === categoryTree.total.actual + categoryMissing + unknownCategory + receiptMissing
  // Lenses are excluded from that sum on purpose — that IS what "overlapping" means.
  variableTotal: number; unbudgeted: number; categoryMissing: number; unknownCategory: number;
  receiptMissing: number; receiptMissingCount: number;
  // Where in the month we are — drives the running projection ("Tag 12/31").
  isCurrentMonth: boolean; daysElapsed: number; daysTotal: number;
  // Set when the response covers an explicit from/to window instead of one calendar
  // month. The monthly halves (incomes, fixed, targets, forecasts) then come back empty
  // or null because they have no defined meaning over an arbitrary period — a monthly
  // goal over 47 days, or per-month recurring rows summed over a window ending mid-month.
  ranged?: boolean;
  // The window this payload actually covers — sent only in range mode (null for a month).
  // Read instead of the pickers wherever a deep link has to describe the € standing next
  // to it, so the link cannot drift from the number while a new period is in flight.
  from?: string | null; to?: string | null;
}

const today = () => todayLocal();
const curMonth = () => new Date().toISOString().slice(0, 7);
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const shiftMonth = (m: string, d: number) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1 + d, 1)).toISOString().slice(0, 7);
};
/** Last calendar day of a YYYY-MM as YYYY-MM-DD (day 0 of the next month). */
const lastDayOf = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
};
/** A REAL calendar day, one half of the Zeitraum. The shape alone is not enough: the regex
 *  waves through 2026-02-31, which Date silently rolls forward to 2026-03-03 — the header
 *  would then assert a window neither the URL nor the request names, while the backend
 *  answers that same request with 400 and the page collapses into the error card with no
 *  hint at the field that broke (a native date input renders a day it cannot represent as
 *  EMPTY). Hence the round trip, the exact one `isoDay` does in
 *  backend/src/routes/finances.ts: a day only this side accepts is a period the page can
 *  never show. The pickers cannot produce such a value, but a hand-edited or truncated link
 *  and the assistant's answer can. */
const isDay = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // NaN first: toISOString() THROWS on an invalid date (2026-13-01), it does not return ''.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
/** A from/to pair that happens to be exactly one whole calendar month. Such a window is
 *  better shown AS that month — the full page, plans, goals and forecast included — than
 *  as a range, which by design has to hide all of that. */
const isWholeMonth = (from: string, to: string) =>
  from.slice(0, 7) === to.slice(0, 7) && from.endsWith('-01') && to === lastDayOf(to.slice(0, 7));

function useKonten() {
  return useQuery({ queryKey: ['konten'], queryFn: () => api<KontoLite[]>('/api/konten') });
}
// Shared "Haushaltskonto" → "Haushalt"; other shared accounts keep their name;
// personal accounts show the owner, else the account name.
function scopeLabelOf(t: (k: string) => string, k: { is_shared?: boolean | null; name?: string | null; owner?: string | null; owner_name?: string | null; konto_name?: string | null } | undefined | null): string {
  if (!k) return '?';
  const name = (k as { name?: string | null }).name ?? (k as { konto_name?: string | null }).konto_name ?? '';
  if (k.is_shared) return /haushalt/i.test(name ?? '') ? t('finances.household') : (name ?? '?');
  // Prefer the linked household member's name over the raw username.
  return k.owner_name ?? k.owner ?? name ?? '?';
}

/** Collapsible section with a chevron header (month-view groups). */
function Section({ title, count, right, defaultOpen = true, children }: {
  title: string; count?: number; right?: ReactNode; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-sm font-semibold">
          <ChevronDown size={15} className={cn('shrink-0 text-zinc-400 transition-transform', !open && '-rotate-90')} />
          {title}{count != null && <span className="font-normal text-zinc-400">· {count}</span>}
        </button>
        {right}
      </div>
      {open && children}
    </div>
  );
}

/** Pill toggle for the account-holder / account scope filter. */
function ScopeBubble({ active, small, onClick, children }: { active: boolean; small?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={cn(
      'shrink-0 rounded-full border font-medium transition-colors',
      small ? 'px-2.5 py-0.5 text-[11px]' : 'px-3 py-1 text-xs',
      active ? 'border-transparent bg-violet-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400',
    )}>{children}</button>
  );
}

// ── page shell: tabs ────────────────────────────────────────────────────────

export function Finanzen() {
  const { t } = useTranslation();
  const [tab, setTab] = useUrlState('tab', 'monat');
  const { demo: demoUser } = useAuth();
  // ?tab=bank is a real URL a demo visitor can arrive at (shared link, bookmark, back button)
  // and the tab button is gone there, so fold it to the month view rather than render a tab
  // with no way back to it.
  const activeTab = demoUser && tab === 'bank' ? 'monat' : tab;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wallet size={20} className="text-emerald-500" />
          <h1 className="text-lg font-bold">{t('finances.title')}</h1>
        </div>
        <div className="flex rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/60">
          {/* Auszüge is dropped on the demo: bank CSV import is refused there, so bank_tx can
              never fill and the tab's only reachable state is an empty state telling the visitor
              to upload a CSV — pointing at a button that isn't offered. Dropping the whole tab
              also removes the konto/month filters, status chips, import-batch card and rematch
              button, all equally inert for the same reason. */}
          {(demoUser
            ? ([['monat', 'finances.monthTab'], ['verwaltung', 'finances.manageTab']] as const)
            : ([['monat', 'finances.monthTab'], ['bank', 'finances.bankTab'], ['verwaltung', 'finances.manageTab']] as const)
          ).map(([tb, key]) => (
            <button key={tb} onClick={() => setTab(tb)}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                activeTab === tb ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>
      {activeTab === 'verwaltung' ? <ManageTab /> : activeTab === 'bank' ? <BankTab /> : <MonthTab />}
    </div>
  );
}

// ── month view ──────────────────────────────────────────────────────────────

/** What the assistant (/api/spending/ask) answers with. It only ever SETS this page's
 *  filters — every € on screen is computed by the deterministic endpoints below, never
 *  by the model. Ported together with the search bar from the retired Statistik page. */
interface AiAnswer {
  category_path: string | null;
  category_label: string | null;
  canonicals: string[];
  group_label: string | null;
  from: string | null;
  to: string | null;
  konto_ids: number[];
  answer: string | null;
  clarify: string | null;
}
/** The answer as the page actually applied it. `konto_ids` is narrowed to the accounts the
 *  bubble scope could really express and `droppedKonten` holds the rest, so the banner can
 *  never claim a filter that was not applied. */
type AiState = AiAnswer & { droppedKonten: number[] };
/** An explicit analysis period. The month view itself is month-scoped by construction
 *  (plans and limits are monthly), so a range lives where range analysis belongs: in the
 *  spending drill-down and in the assistant's answer card. Both read the SAME deterministic
 *  /api/spending endpoints, which have supported from/to all along. */
interface DateRange { from: string; to: string }
/** The spending-over-time drilldown targets either a whole category subtree or a set of
 *  articles by canonical name (the assistant can group articles across categories). */
type DrillTarget =
  | { kind: 'category'; path: string; label: string }
  | { kind: 'article'; canonicals: string[]; label: string };
/** What the positions list is scoped to. `q` is the selector the backend expects
 *  (`path=…` for a tree node, `budget=…` for a stored limit/lens); `bases` are the
 *  category paths its rows get grouped under ("Nach Kategorien"). */
interface PosTarget { label: string; q: string; bases: string[] }
/** Draft handed to BudgetModal. `kind` is immutable once stored, so an edit — and a
 *  create that starts from a category row — locks the switcher. */
interface BudgetDraft {
  id?: number; kind: 'category' | 'lens'; lockKind?: boolean;
  label?: string; monthly_target?: number | null; konto_id?: number | null;
  categories?: string[]; articles?: string[];
}

function MonthTab() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [fx, setFx] = useUrlState('fx', '');   // deep-link from Auszüge: open this plan's evidence

  // ── the period, entirely in the URL ──────────────────────────────────────
  // The month AND the from/to window, so a reload comes back on the period the numbers
  // were computed for and the address bar is a shareable link to exactly this view.
  //
  // NOT three useUrlState slots, and this is the whole reason for the hand-rolled writer
  // below: that hook's setter builds its update from the params of the render it was
  // created in, so two setters fired in the SAME tick both write onto the same stale
  // snapshot and the second silently drops the first's key. Every period change here moves
  // at least two keys at once — the assistant sets month+from+to, tapping a month in a
  // drill-down chart clears the window AND jumps the month — so there is exactly one writer
  // and it does exactly one setParams.
  const [params, setParams] = useSearchParams();
  const month = params.get('m') || curMonth();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const [aiAnswer, setAiAnswer] = useState<AiState | null>(null);
  // The assistant's banner asserts a period and an account scope, while every € under it
  // is recomputed the moment either changes — so a surviving banner would keep stating an
  // answer that no longer matches the numbers on screen. Any period/scope change drops it;
  // askAI sets the fresh answer AFTER its own changes, so it is unaffected.
  const dropAi = () => setAiAnswer(null);
  // Is this tab still on screen? The ✨ answer lands after a multi-second LLM round trip,
  // and picking another tab UNMOUNTS this one (Finanzen renders exactly one of the three),
  // while react-router's navigate keeps navigating from an unmounted component — it never
  // clears its activeRef — so a late answer would rewrite the URL of, and yank the user
  // back to, a view they had already left. Re-armed in the effect BODY, not only cleared in
  // the cleanup: StrictMode mounts, unmounts and remounts every component in dev.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  /** The single period writer. Keys absent from `patch` keep their current value; a `''`
   *  DELETES its key, which is what makes clearing the Zeitraum drop both halves instead of
   *  leaving an orphan `?from=` behind. The current month is elided rather than written,
   *  exactly as useUrlState treats its default, so a bare /finanzen link keeps following
   *  "today" instead of freezing on whichever month it was copied in. `replace` matches
   *  useUrlState too — paging months must not pile up history entries. */
  const setPeriod = (patch: { m?: string; from?: string; to?: string }) => {
    if (!alive.current) return;
    dropAi();
    // Merged onto the query string that is live RIGHT NOW — deliberately not onto the
    // `params` of the render this closure was created in. askAI writes its period AFTER an
    // await, so whatever reached the URL meanwhile (another tab, that tab's own filters)
    // would be silently dropped by a rebuild from the render's snapshot. react-router's
    // functional form is no way out: setSearchParams(prev => …) hands back that very same
    // render-scoped snapshot (react-router-dom 6.30, useSearchParams). BrowserRouter pushes
    // through the History API synchronously, so this also reads back what a write earlier
    // in the same tick left behind.
    const np = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v && !(k === 'm' && v === curMonth())) np.set(k, v); else np.delete(k);
    }
    setParams(np, { replace: true });
  };
  const setMonth = (m: string) => setPeriod({ m });
  const clearRange = () => setPeriod({ from: '', to: '' });

  // An explicit from/to window — the date-range filter restored from the Statistik page
  // this one absorbed. It REPLACES the month rather than narrowing it: plans, goals and
  // the 3-month-median forecast are monthly by construction, so over an arbitrary window
  // the page shows only the half that survives it — the variable spend (see `rangeMode`
  // branches below).
  //
  // Two independent date pickers make an inverted window ("20.07. – 05.07.") one fat finger
  // away, and that is exactly what /api/finances/month answers with 400 — while every
  // branch of this page renders off the fetched `data`, so the rejected request used to
  // leave a header with nothing under it. An unusable pair is therefore NOT a period: the
  // page keeps showing the month it was already on and the filter says why, right at the
  // field that broke. Only a pair the backend would accept becomes range mode. Now that the
  // pair is URL-borne this also guards a hand-edited or truncated link, not just a typo.
  const rangeBroken = !!(from && to) && (!isDay(from) || !isDay(to) || from > to);
  // Exactly ONE half present — the pair still being typed, or a link that arrived carrying
  // only one key. Neither is a period: the backend answers a lone half with 400, so
  // `rangeMode` demands both and a half leaves the month in effect. The panel states that,
  // so the numbers on screen are never silently read as "since the 20th".
  const rangeHalf = !!from !== !!to;
  const rangeMode = !!(from && to) && !rangeBroken;
  // The page's own period, in the shape the /api/spending endpoints want it.
  const pageRange: DateRange | null = rangeMode ? { from, to } : null;

  const [picker, setPicker] = useState<MonthFix | null>(null);
  const [budgetModal, setBudgetModal] = useState<BudgetDraft | null>(null);
  const [posTarget, setPosTarget] = useState<PosTarget | null>(null);
  // The drill-down carries its own period (null = follow the page's month), and can be
  // re-pointed from inside the modal without moving the page.
  const [drill, setDrill] = useState<{ target: DrillTarget; range: DateRange | null } | null>(null);
  // Default period = whatever the page is showing, so in range mode every drill-down
  // opens on that window instead of silently falling back to the (hidden) month.
  const openDrill = (target: DrillTarget, range: DateRange | null = pageRange) => setDrill({ target, range });
  const [evidence, setEvidence] = useState<{ id: number; label: string; kind: 'expense' | 'income'; expectReceipt: boolean } | null>(null);
  // Tree folding. We store DEVIATIONS from the default (level 1 open, everything below
  // it closed) rather than the open set itself: 84 categories expanded at once is
  // unusable on a phone, and a fresh load must always come up folded the same way.
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  // Per-parent "also show the children that carry no money and no goal". They still
  // EXIST — that is the whole point of a derived tracker — they are just not worth a row
  // until you go looking for them.
  const [showEmpty, setShowEmpty] = useState<Set<string>>(new Set());

  // Search + ✨ + filter bar, ported 1:1 from the Statistik page this one absorbed.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [asking, setAsking] = useState(false);

  // Account-holder scope: one bubble per person + one for the household account;
  // default = all (Gesamthaushalt). Selecting a single person reveals sub-bubbles
  // for that person's accounts (subtractive). The chosen konto_ids scope the view,
  // which makes internal transfers (Beiträge) net out in the whole-household view.
  const { data: konten } = useKonten();
  const scope = useMemo(() => {
    const nonCash = (konten ?? []).filter(k => !k.is_cash);
    const memberMap = new Map<number, { key: string; label: string; konten: KontoLite[] }>();
    const household: KontoLite[] = [];
    for (const k of nonCash) {
      if (k.is_shared) household.push(k);
      else if (k.user_id != null) {
        if (!memberMap.has(k.user_id)) memberMap.set(k.user_id, { key: `u${k.user_id}`, label: k.owner_name ?? k.owner ?? k.name, konten: [] });
        memberMap.get(k.user_id)!.konten.push(k);
      }
    }
    const members = [...memberMap.values()].sort((a, b) => a.label.localeCompare(b.label));
    const allKeys = [...members.map(m => m.key), ...(household.length ? ['household'] : [])];
    return { members, household, allKeys };
  }, [konten]);
  const [selKeys, setSelKeys] = useState<Set<string> | null>(null);   // null = all
  const [exclKonten, setExclKonten] = useState<Set<number>>(new Set());
  const activeKeys = selKeys ?? new Set(scope.allKeys);
  const soleMember = activeKeys.size === 1 ? scope.members.find(m => activeKeys.has(m.key)) : undefined;
  const effKonten = useMemo(() => {
    const ids: number[] = [];
    for (const m of scope.members) if (activeKeys.has(m.key)) ids.push(...m.konten.map(k => k.id));
    if (scope.household.length && activeKeys.has('household')) ids.push(...scope.household.map(k => k.id));
    return ids.filter(id => !exclKonten.has(id));
  }, [scope, activeKeys, exclKonten]);
  const isAll = !selKeys && exclKonten.size === 0;
  const toggleGroup = (key: string) => {
    const next = new Set(activeKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    dropAi();
    setExclKonten(new Set());
    setSelKeys(next.size === 0 || next.size === scope.allKeys.length ? null : next);
  };
  const toggleKonto = (id: number) => { dropAi(); setExclKonten(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const kontenParam = isAll ? '' : `&konten=${effKonten.join(',')}`;
  // Every konto the bubble scope can actually express. `scope` above is built from
  // non-cash, user-linked accounts ONLY, while the assistant grounds its answer on the full
  // `konto` table (statsAsk.ts) — so a legitimate id (a Bargeld account, an account linked
  // to nobody) simply has no bubble to switch on.
  const scopeKontoIds = useMemo(() => {
    const s = new Set<number>();
    for (const m of scope.members) for (const k of m.konten) s.add(k.id);
    for (const k of scope.household) s.add(k.id);
    return s;
  }, [scope]);
  // The assistant answers with raw konto IDs; this page's scope model is groups (person /
  // household) plus per-konto exclusions. Map one onto the other: select every group that
  // owns at least one of the ids, then exclude that group's OTHER accounts, so "was hat
  // Lena auf dem Girokonto ausgegeben" lands on exactly that account.
  // Returns the ids it could really apply. Anything else is REPORTED, never swallowed: the
  // old code let an unrepresentable id fall through to "no group selected" = ALL accounts
  // while the banner still rendered that account's chip, so the page asserted a filter it
  // had never applied — the exact opposite of what was asked for.
  const applyKonten = (ids: number[]): number[] => {
    if (!ids.length) { setSelKeys(null); setExclKonten(new Set()); return []; }
    const usable = ids.filter(id => scopeKontoIds.has(id));
    // Nothing expressible → leave the scope exactly as the user had it. Widening it to the
    // whole household would answer a narrower question than the one that was asked.
    if (!usable.length) return [];
    const keys = new Set<string>();
    const excl = new Set<number>();
    for (const m of scope.members) if (m.konten.some(k => usable.includes(k.id))) keys.add(m.key);
    if (scope.household.some(k => usable.includes(k.id))) keys.add('household');
    for (const m of scope.members) if (keys.has(m.key)) for (const k of m.konten) if (!usable.includes(k.id)) excl.add(k.id);
    if (keys.has('household')) for (const k of scope.household) if (!usable.includes(k.id)) excl.add(k.id);
    setExclKonten(excl);
    setSelKeys(keys.size === 0 || keys.size === scope.allKeys.length ? null : keys);
    return usable;
  };

  // month=… is always sent (the endpoint requires it); from/to override it when set.
  const rangeParam = rangeMode ? `&from=${from}&to=${to}` : '';
  const { data, isLoading, isError, error, refetch } = useQuery({
    // lang picks category display vs display_en on the tree — part of the key or a
    // language switch would keep serving the other language's labels from cache. The key
    // holds `rangeParam`, not raw from/to, for the same reason AND so it varies with what
    // is actually requested: while a half-typed or inverted window is on screen the month
    // is what gets fetched, so it must hit the month's own cache entry instead of emptying
    // the page into a spinner on every keystroke.
    queryKey: ['fin-month', month, rangeParam, isAll ? 'all' : effKonten.join(','), i18n.language],
    queryFn: () => api<MonthData>(`/api/finances/month?month=${month}${rangeParam}${kontenParam}&lang=${i18n.language}`),
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['fin-month'] });

  // Enter (or the ✨ button) hands the question to the assistant, which answers with THIS
  // page's filters — and we APPLY them, so the page really shows the period that was asked
  // about. A question whose period is not one whole calendar month ("wie viel habe ich 2026
  // für Kraftstoff ausgegeben") switches the page into range mode over that window; a
  // question about one month stays in month mode, where the full page still has meaning.
  const askAI = async () => {
    const q = search.trim();
    if (!q || asking) return;
    setAsking(true);
    try {
      const res = await api<AiAnswer>('/api/spending/ask', { method: 'POST', body: { q, lang: i18n.language } });
      // The month is set whenever the ANSWER carries one: it is what the page falls back to
      // once the range is cleared, so clearing lands on the question's own month, not on
      // today. Month and window still travel in ONE setPeriod call — one logical period
      // change should be one navigation and one re-render, not two.
      // Everything that is NOT one whole calendar month becomes a real range — a
      // multi-month span AND a sub-month window ("vom 5. bis 20. März"). Rendering the
      // date chip without applying it is what made the old banner claim a period the
      // numbers underneath were never computed for.
      // A date-less answer ("was gebe ich für Kraftstoff aus") writes NO month: the only
      // value on offer would be `month` as it stood before the await, which would undo a
      // month the user paged to while the assistant was thinking. Leaving the key alone
      // keeps the period that is actually in effect — the same one the answer describes.
      if (res.from && res.to && !isWholeMonth(res.from, res.to)) setPeriod({ m: res.from.slice(0, 7), from: res.from, to: res.to });
      else if (res.from) setPeriod({ m: res.from.slice(0, 7), from: '', to: '' });
      else setPeriod({ from: '', to: '' });
      const applied = applyKonten(res.konto_ids ?? []);
      const dropped = (res.konto_ids ?? []).filter(id => !applied.includes(id));
      setAiAnswer({ ...res, konto_ids: applied, droppedKonten: dropped });
      setSearch('');
    } catch {
      setAiAnswer({ category_path: null, category_label: null, canonicals: [], group_label: null, from: null, to: null, konto_ids: [], droppedKonten: [], answer: null, clarify: t('stats.aiError') });
    } finally {
      setAsking(false);
    }
  };

  // Article names → their category, for the search box (an article jumps to its purchases).
  const { data: names = [] } = useQuery({
    queryKey: ['names'],
    queryFn: () => api<{ canonical_name: string; category_path: string | null }[]>('/api/names'),
  });

  const check = useMutation({
    mutationFn: (b: { fixed_cost_id: number; month: string; action: 'confirm' | 'skip' | 'clear'; einkauf_id?: number | null; bank_tx_id?: number | null; income_id?: number | null }) =>
      api('/api/finances/check', { method: 'POST', body: b }),
    onSuccess: () => { invalidate(); setPicker(null); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // "Kein Beleg vorhanden" from the evidence modal: this fixed cost has no invoice →
  // stop expecting one (also flips it to auto-confirmed in months without evidence).
  const expectReceiptOff = useMutation({
    mutationFn: (id: number) => api(`/api/fixed-costs/${id}`, { method: 'PATCH', body: { expect_receipt: false } }),
    onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['fixed-costs'] }); toast(t('finances.evNoReceiptDone'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // Undo "kein Beleg vorhanden": start expecting a receipt again for this fixed cost.
  const expectReceiptOn = useMutation({
    mutationFn: (id: number) => api(`/api/fixed-costs/${id}`, { method: 'PATCH', body: { expect_receipt: true } }),
    onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['fixed-costs'] }); void qc.invalidateQueries({ queryKey: ['fix-evidence'] }); toast(t('finances.evExpectReceiptOn'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // "Nicht mehr aktiv": the plan shows up this month but shouldn't — end it at the
  // last day of the PREVIOUS month (so this month & later drop it, earlier months keep it).
  const priorMonthEnd = () => {
    const [y, mo] = month.split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1, 0)).toISOString().slice(0, 10);
  };
  const endPlan = useMutation({
    mutationFn: (id: number) => api(`/api/fixed-costs/${id}`, { method: 'PATCH', body: { end_date: priorMonthEnd() } }),
    onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['fixed-costs'] }); toast(t('finances.evEndDone'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(
    i18n.language === 'en' ? 'en-GB' : 'de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  // What the payload ON SCREEN actually is, in the server's own words (`ranged` in the
  // /api/finances/month contract). `rangeMode` says what the FILTER asks for; the two are
  // different questions and only one of them can answer "may I draw this?". A ranged
  // payload carries no incomes/fixed at all and its category actuals are window sums, so
  // rendering the month summary or a monthly target bar over it would print 0,00 € twice
  // and measure a 47-day sum against a per-month goal. Falls back to the local intent only
  // while there is NO payload, so the page comes up in the mode that was asked for instead
  // of flashing the other layout — and once data is here the whole block below switches on
  // one boolean, so the section can never render half in one mode and half in the other.
  const dataRanged = data?.ranged ?? rangeMode;

  const incomes = data?.incomes ?? [];   // recurring income PLANS (Einnahmen-Soll)
  const fixed = data?.fixed ?? [];
  const lenses = data?.lenses ?? [];
  const orphanLimits = data?.orphanLimits ?? [];
  const variableTotal = data?.variableTotal ?? 0;
  const unbudgeted = data?.unbudgeted ?? 0;
  const categoryMissing = data?.categoryMissing ?? 0;
  const unknownCategory = data?.unknownCategory ?? 0;
  const receiptMissing = data?.receiptMissing ?? 0;
  const receiptMissingCount = data?.receiptMissingCount ?? 0;

  // ── derived category tree ────────────────────────────────────────────────
  const treeNodes = data?.categoryTree?.nodes ?? [];
  const nodeByPath = useMemo(() => new Map(treeNodes.map(n => [n.path, n])), [treeNodes]);
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, MonthCategoryNode[]>();
    for (const n of treeNodes) { const k = n.parent_path ?? null; const list = m.get(k) ?? []; list.push(n); m.set(k, list); }
    return m;
  }, [treeNodes]);
  // "Substantial" = this node, or anything below it, actually carries money or a stored
  // goal. Everything else is real and reachable (see the "+ n weitere" row) but does not
  // deserve a permanent row: showing all 84 categories at once is unusable on a phone.
  // `actual` is subtree-inclusive, so a parent inherits its children's spend for free;
  // the ancestor walk is only needed for a zero-spend category that DOES carry a goal.
  const substantial = useMemo(() => {
    const s = new Set<string>();
    for (const n of treeNodes) {
      if (n.actual === 0 && !n.limit && !n.extra_limits?.length) continue;
      let cur: MonthCategoryNode | undefined = n;
      for (let guard = 0; cur && guard < 8; guard++) { s.add(cur.path); cur = cur.parent_path ? nodeByPath.get(cur.parent_path) : undefined; }
    }
    return s;
  }, [treeNodes, nodeByPath]);
  // Level 1 is open by default, everything below it closed — `toggled` flips that.
  const isOpen = (n: MonthCategoryNode) => (n.level === 1) !== toggled.has(n.path);
  const flip = (set: Set<string>, p: string) => { const nx = new Set(set); if (nx.has(p)) nx.delete(p); else nx.add(p); return nx; };

  const openPositions = (label: string, path: string) =>
    setPosTarget({ label, q: `path=${encodeURIComponent(path)}`, bases: [path] });
  // Edit ONE stored limit of a node — the primary one, or (see `extra_limits`) any of the
  // legacy duplicates that also claim this path. `l == null` means "no limit yet, create one".
  const editLimit = (n: MonthCategoryNode, l: BudgetLimit | null) => setBudgetModal(l
    ? { id: l.id, kind: 'category', lockKind: true, label: l.label, monthly_target: l.monthly_target, konto_id: l.konto_id, categories: [n.path], articles: [] }
    : { kind: 'category', lockKind: true, label: n.label, categories: [n.path], articles: [] });

  const renderNode = (n: MonthCategoryNode): ReactNode => {
    // Level 4+ exists in the catalogue but never gets a row: `actual` is subtree-inclusive,
    // so its money is already inside its level-3 ancestor — only the row is folded away.
    const kids = (childrenOf.get(n.path) ?? []).filter(c => c.level <= 3);
    // `empties` is computed from `substantial` ALONE, never from what is currently on
    // screen: the toggle has to keep rendering after it has been used, or unhiding would be
    // a one-way door (the button that flips `showEmpty` was its own only unmount trigger).
    const empties = kids.filter(c => !substantial.has(c.path)).length;
    const revealed = showEmpty.has(n.path);
    const shown = revealed ? kids : kids.filter(c => substantial.has(c.path));
    const open = isOpen(n);
    return (
      <div key={n.path}>
        <CategoryRow n={n} t={t} hasKids={kids.length > 0} open={open} scopedToPerson={!isAll} ranged={dataRanged}
          onToggle={() => setToggled(s => flip(s, n.path))}
          onOpen={() => openPositions(n.label, n.path)}
          onChart={() => openDrill({ kind: 'category', path: n.path, label: `${n.emoji ?? ''} ${n.label}`.trim() })}
          onEdit={() => editLimit(n, n.limit)}
          onEditExtra={l => editLimit(n, l)} />
        {open && shown.map(renderNode)}
        {open && empties > 0 && (
          // Indent = the child rows' own indent ((level+1-1)*12) plus the 28px chevron
          // gutter, so the row lines up with the labels it unhides.
          <button onClick={() => setShowEmpty(s => flip(s, n.path))}
            className="w-full py-1.5 text-left text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            style={{ paddingLeft: `${n.level * 12 + 28}px` }}>
            {revealed ? `− ${t('finances.hideEmptyCats', { count: empties })}` : `+ ${t('finances.showEmptyCats', { count: empties })}`}
          </button>
        )}
      </div>
    );
  };

  // Search: matching categories (any level, most-spent first) and matching article names.
  // A category hit opens its positions; an article hit opens ITS purchases, not its
  // category — asking for "Diesel" should not drill the whole Sonstiges bucket.
  const searchLc = search.trim().toLowerCase();
  const catHits = searchLc ? treeNodes.filter(n => n.label.toLowerCase().includes(searchLc)).sort((a, b) => b.actual - a.actual).slice(0, 40) : [];
  const articleHits = useMemo(() => {
    if (!searchLc) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const nm of names) {
      const cName = (nm.canonical_name ?? '').trim();
      const key = cName.toLowerCase();
      if (!cName || seen.has(key) || !key.includes(searchLc)) continue;
      seen.add(key);
      out.push(cName);
      if (out.length >= 40) break;
    }
    return out.sort((a, b) => a.localeCompare(b));
  }, [names, searchLc]);
  // The dot means "something set INSIDE this panel is narrowing the view" — the account
  // scope, or a Zeitraum. Deliberately not the month: the header arrows page months from
  // outside the panel, so counting that lit the dot on the single most ordinary action on
  // the page and drowned out the one thing it now has to carry, namely that the person
  // bubbles (which moved INTO the panel) have scoped the view to one account holder.
  // Dates that are not in effect (half-entered or inverted) still count: they are sitting
  // in the panel, and once it is closed the dot is the only way back to the message that
  // explains why the month is still what you are looking at.
  const hasActiveFilters = !isAll || !!from || !!to;
  // The window the numbers on this page were computed for, as plain dates — what the
  // bucket tiles deep-link into (Positionen takes from/to, not a month). Taken from the
  // PAYLOAD's own window, because these links sit next to a € from that same payload: a
  // link built from the pickers would describe a period the number beside it was never
  // computed for the moment a new period is in flight.
  const periodFrom = dataRanged ? (data?.from ?? from) : `${month}-01`;
  const periodTo = dataRanged ? (data?.to ?? to) : lastDayOf(month);

  // Deep-link from the Auszüge list (?fx=<id>): open that plan's evidence modal so a
  // statement allocated to a generated one-off income jumps straight to the entry.
  useEffect(() => {
    if (!fx || !data) return;
    const f = [...(data.incomes ?? []), ...(data.fixed ?? [])].find(p => String(p.id) === fx);
    if (f) { setEvidence({ id: f.id, label: f.label, kind: f.kind, expectReceipt: f.expect_receipt }); setFx(''); }
  }, [fx, data, setFx]);
  // Summary mirrors fixed costs: sum the PLANS (Soll), not just the matched actuals.
  // Internal transfers (Umbuchung) net to zero ONLY when BOTH legs are in scope — then
  // the +X income and −X expense cancel and neither should inflate the gross totals. A
  // transfer whose counterpart is NOT in the current data — a single-account view (only
  // one leg fetched) or an untracked/external transfer (no counterpart at all) — is real
  // money moving in/out of the visible accounts, so it counts. Keying off counterpart
  // presence (not the coarse isAll flag) fixes: partial scopes double-counting both
  // legs, and the household view silently dropping an unpaired transfer.
  const presentIds = useMemo(() => new Set([...incomes, ...fixed].map(f => f.id)), [incomes, fixed]);
  const nets = (f: MonthFix) => f.is_transfer && f.counterpart_id != null && presentIds.has(f.counterpart_id);
  const counts = (f: MonthFix) => !nets(f);
  // Effective amount for the summary: once a match is CONFIRMED, the real value (from
  // the receipt / bank / pay slip) replaces the plan value (e.g. a salary with a bonus,
  // or a month where it was less than planned). Falls back to the plan (Soll) until then.
  const effEur = (f: MonthFix) => amortized(f.check?.status === 'confirmed' && f.check.amount != null ? f.check.amount : f.monthly_eur, f.frequency);
  // 2×2 for the month lists: FIXED (recurring) vs VARIABLE (single-month one-off) on
  // both the income and the cost side. One-offs are the generated single-month entries.
  const fixedIncome = incomes.filter(f => !f.one_off);
  const varIncome = incomes.filter(f => f.one_off);
  const fixedCosts = fixed.filter(f => !f.one_off);
  const oneOffCosts = fixed.filter(f => f.one_off);
  const fixRow = (f: MonthFix) => (
    <FixCheckRow key={f.id} f={f} month={month} t={t} excluded={!counts(f)}
      onConfirmSuggestion={() => confirmSug(f)}
      onClear={() => check.mutate({ fixed_cost_id: f.id, month, action: 'clear' })}
      onShowEvidence={() => setEvidence({ id: f.id, label: f.label, kind: f.kind, expectReceipt: f.expect_receipt })} />
  );
  // Summary tiles mirror the 2×2 lists so the numbers match the sections beneath them:
  //   Einnahmen = ALL income · Fixkosten = RECURRING costs only (one-offs live under
  //   Variable Kosten) · Variable Kosten = the month's TRUE variable spend (every receipt
  //   line ONCE) + one-off costs — NOT the sum of budget actuals, which overlap and would
  //   double-count. Budgets are only spending goals shown against this total. Net covers all.
  const incomeTotal = incomes.reduce((s, f) => s + (counts(f) ? effEur(f) : 0), 0);
  const fixTotal = fixedCosts.reduce((s, f) => s + (counts(f) ? effEur(f) : 0), 0);
  const oneOffCostTotal = oneOffCosts.reduce((s, f) => s + (counts(f) ? effEur(f) : 0), 0);
  const varActual = variableTotal + oneOffCostTotal;
  // No top-line "of target": varActual is the true total spend (incl. spend outside any
  // goal), while goals can overlap (a "Lebensmittel" limit and a nested "Obst" limit, and
  // lenses overlap everything) — summing them and comparing to the total is
  // apples-to-oranges. Each row tracks its own goal on its own bar instead.
  const net = Math.round((incomeTotal - fixTotal - varActual) * 100) / 100;
  // Running projection for the CURRENT month, restored from the (absorbed) Statistik page:
  // "day 12 of 31 → this pace ends the month at X". It projects exactly the number it sits
  // under, so it is honest about which figure it is extrapolating — unlike a projection of
  // the category tree shown beneath a total that also carries one-offs and un-receipted
  // debits. Past/future months elapse fully, so there is nothing to project — and an
  // arbitrary window has no "rest of the period" to extrapolate into either.
  const varProjection = !dataRanged && data?.isCurrentMonth && data.daysElapsed > 0
    ? Math.round((varActual * data.daysTotal / data.daysElapsed) * 100) / 100
    : null;
  // Reconciliation completeness covers EVERY plan that still needs a bank match —
  // recurring AND one-off, income AND cost — except internal transfers that net out
  // (shown struck through / "nicht gezählt"), which mirrors the euro totals above. A
  // generated one-off that arrived with its bank leg is already `complete`, so it counts
  // as done and never falsely drags the meter down.
  const countableFixed = fixedCosts.filter(counts);
  const fixDone = countableFixed.filter(f => f.complete).length;
  const reconItems = [...incomes, ...fixed].filter(counts);
  const planTotal = reconItems.length;
  const planDone = reconItems.filter(f => f.complete).length;
  const donePct = planTotal ? Math.round((planDone / planTotal) * 100) : 100;

  // When the evidence amount differs from the plan (a bonus on the salary, a cheaper
  // month …), ask whether to accept the delta; the real value then replaces the plan.
  const okDelta = async (f: MonthFix, actual: number | null | undefined): Promise<boolean> => {
    if (actual == null) return true;
    if (Math.abs(Math.round((actual - f.monthly_eur) * 100) / 100) < 0.01) return true;
    return confirm({
      title: t('finances.deltaTitle'),
      message: t('finances.deltaMsg', { plan: eur(f.monthly_eur), actual: eur(actual) }),
      confirmLabel: t('finances.deltaAccept'), cancelLabel: t('common.cancel'),
    });
  };
  // Confirm the auto-suggestion, passing the id of whichever evidence kind it is.
  const confirmSug = async (f: MonthFix) => {
    if (!(await okDelta(f, f.suggestion?.betrag))) return;
    check.mutate({
      fixed_cost_id: f.id, month, action: 'confirm',
      einkauf_id: f.suggestion!.source === 'receipt' ? f.suggestion!.einkauf_id : null,
      bank_tx_id: f.suggestion!.source === 'bank' ? f.suggestion!.bank_tx_id : null,
      income_id: f.suggestion!.source === 'income' ? f.suggestion!.income_id : null,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* month navigation — or, in range mode, the active window. The arrows are not just
          disabled but gone: shifting a month is meaningless while a from/to window is what
          every number below was computed for. */}
      <div className="flex items-center justify-center gap-3">
        {rangeMode ? (
          <>
            <span className="text-base font-semibold">{fmtDate(from, i18n.language)} – {fmtDate(to, i18n.language)}</span>
            <button onClick={clearRange} title={t('stats.monthReset')}
              className="rounded-lg px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:text-emerald-500 dark:hover:bg-emerald-950/40">
              {t('stats.monthReset')}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" aria-label="◄">
              <ChevronLeft size={18} />
            </button>
            <button onClick={() => setMonth(curMonth())} className="min-w-[10rem] text-center text-base font-semibold" title={t('finances.jumpToday')}>
              {monthLabel}
            </button>
            <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" aria-label="►">
              <ChevronRight size={18} />
            </button>
          </>
        )}
      </div>

      {isLoading && <Spinner />}
      {/* A failed request (a period the backend rejects, a 500, no network) used to leave
          this page as a bare header: everything under it renders off `data`, and there is
          no global query-error handler (main.tsx). Say it out loud instead — the search and
          filter bar below stay mounted, so the period that caused it can be corrected. */}
      {isError && (
        <Card className="flex flex-col items-start gap-2 border-red-200 p-4 dark:border-red-900/60">
          <div className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
            <AlertCircle size={16} className="shrink-0" />
            {t('finances.loadError')}
          </div>
          {error instanceof Error && error.message && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{error.message}</p>
          )}
          <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => void refetch()}>
            <RefreshCw size={14} /> {t('finances.retry')}
          </Button>
        </Card>
      )}
      {/* Range mode summarises only what a window can defend: the variable spend. No
          Einnahmen/Fixkosten tiles (per-MONTH recurring rows, wrong the moment a window
          ends mid-month), hence no Netto and no reconciliation meter either. Which card
          shows is decided by the PAYLOAD (`dataRanged`), not by the filter: the month card
          reads data.incomes/data.fixed, and a ranged payload returns those empty by
          contract — pairing it with the month card would print 0,00 € Einnahmen and a
          0/0 reconciliation meter as if they were facts. */}
      {data && dataRanged && (
        <Card className="flex flex-col gap-1 p-4">
          <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('finances.varTitle')}</div>
          <div className="text-2xl font-bold">{eur(varActual)}</div>
          <div className="text-xs text-zinc-400">{t('finances.rangeVariableOnly')}</div>
        </Card>
      )}
      {data && !dataRanged && (
        <>
          <Card className="flex flex-col gap-3 p-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('finances.incomeTitle')}</div>
                <div className="text-lg font-bold text-emerald-600 dark:text-emerald-500">{eur(incomeTotal)}</div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('finances.fixTitle')}</div>
                <div className="text-lg font-bold">{eur(fixTotal)}</div>
                <div className={cn('text-xs', fixDone === countableFixed.length && countableFixed.length > 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-amber-600 dark:text-amber-500')}>
                  {t('finances.checkedOf', { done: fixDone, total: countableFixed.length })}
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('finances.varTitle')}</div>
                <div className="text-lg font-bold">{eur(varActual)}</div>
                {varProjection != null && data && (
                  <div className="text-xs text-zinc-400" title={t('stats.projection')}>
                    → {eur(varProjection)} · {t('stats.day')} {data.daysElapsed}/{data.daysTotal}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-zinc-100 pt-2 dark:border-zinc-800">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('finances.netTitle')}</span>
              <span className={cn('text-base font-bold', net >= 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-red-500')}>{net >= 0 ? '+' : ''}{eur(net)}</span>
            </div>
            {/* Reconciliation completeness for the month (income plans + fixed costs). */}
            {planTotal > 0 && (
              <div className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-zinc-500 dark:text-zinc-400">{t('finances.allocatedTitle')}</span>
                  <span className={cn('font-semibold', donePct === 100 ? 'text-emerald-600 dark:text-emerald-500' : 'text-amber-600 dark:text-amber-500')}>{donePct}% · {planDone}/{planTotal}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className={cn('h-full rounded-full transition-all', donePct === 100 ? 'bg-emerald-500' : 'bg-amber-500')} style={{ width: `${donePct}%` }} />
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      {/* Search + ✨ assistant + filter — under the summary, above the lists. It replaces
          the old person/household bubble row: the same scope now lives in the filter
          panel together with the month, so there is ONE place that narrows the view. */}
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input
            className="pl-9 pr-16"
            placeholder={t('stats.searchPlaceholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void askAI(); } }}
          />
          <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            {search && !asking && <button onClick={() => setSearch('')} title={t('common.clear')} className="p-1 text-zinc-400 hover:text-zinc-600"><X size={16} /></button>}
            <button onClick={() => void askAI()} disabled={!search.trim() || asking} title={t('stats.askAi')}
              className="p-1 text-emerald-600 hover:text-emerald-700 disabled:text-zinc-300 dark:text-emerald-500 dark:disabled:text-zinc-700">
              {asking ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            </button>
          </div>
        </div>
        <button type="button" onClick={() => setFiltersOpen(o => !o)} aria-pressed={filtersOpen} title={t('stats.filters')}
          className={cn('relative flex shrink-0 items-center rounded-xl border px-2.5 transition',
            filtersOpen ? 'border-emerald-500 bg-emerald-50 text-emerald-600 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' : 'border-zinc-200 text-zinc-400 hover:text-zinc-600 dark:border-zinc-800')}>
          <SlidersHorizontal size={16} />
          {hasActiveFilters && !filtersOpen && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-950" />}
        </button>
      </div>

      {/* Filter panel: period (range OR month) + the account-holder scope. Picking a single
          person reveals that person's accounts as subtractive chips (unchanged behaviour,
          new home). */}
      {filtersOpen && (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-zinc-400">{t('stats.dateRange')}</div>
            <div className="flex items-center gap-2">
              {/* Each field bounds the other, so the picker itself cannot produce an
                  inverted window. Typing can still get past it (min/max only mark the
                  value out-of-range) — `rangeBroken` is the guard that actually holds. */}
              <Input type="date" className="min-w-0 flex-1" max={to || undefined} value={from} onChange={e => setPeriod({ from: e.target.value })} />
              <span className="shrink-0 text-zinc-400">–</span>
              <Input type="date" className="min-w-0 flex-1" min={from || undefined} value={to} onChange={e => setPeriod({ to: e.target.value })} />
              {/* Also offered for a half-entered or inverted window: that is precisely when
                  starting over is what you want, and it was the only state with no way out. */}
              {(from || to) && (
                <button onClick={clearRange} title={t('stats.monthReset')} className="shrink-0 rounded-lg p-1 text-zinc-400 hover:text-zinc-600"><X size={16} /></button>
              )}
            </div>
            {/* Name the actual reason: "end before start" would be a lie about a value that
                is not a calendar day at all (only reachable if a date arrives from outside
                these two pickers). */}
            {rangeBroken && (
              <p className="mt-1.5 text-[11px] text-red-500">
                {isDay(from) && isDay(to) ? t('finances.rangeInverted') : t('finances.rangeBadDate')}
              </p>
            )}
            {rangeHalf && <p className="mt-1.5 text-[11px] text-zinc-400">{t('finances.rangeHalf')}</p>}
          </div>
          {/* One period control at a time: a complete, USABLE range replaces the month, so
              leaving a month picker next to it would offer a control that changes nothing.
              While the range is half-entered or inverted the month is what the page is
              actually showing, so the picker comes back — and the hint above says why. */}
          {!rangeMode && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium text-zinc-400">{t('finances.filterMonth')}</div>
              <div className="flex items-center gap-2">
                <Input type="month" className="min-w-0 flex-1" value={month} onChange={e => e.target.value && setMonth(e.target.value)} />
                <Button variant="ghost" className="shrink-0 px-2.5 py-1.5 text-xs" onClick={() => setMonth(curMonth())}>{t('finances.jumpToday')}</Button>
              </div>
            </div>
          )}
          {scope.allKeys.length > 1 && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium text-zinc-400">{t('stats.accounts')}</div>
              <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5">
                <ScopeBubble active={isAll} onClick={() => { dropAi(); setSelKeys(null); setExclKonten(new Set()); }}>{t('stats.allAccounts')}</ScopeBubble>
                {scope.members.map(m => (
                  <ScopeBubble key={m.key} active={activeKeys.has(m.key)} onClick={() => toggleGroup(m.key)}>{m.label}</ScopeBubble>
                ))}
                {scope.household.length > 0 && (
                  <ScopeBubble active={activeKeys.has('household')} onClick={() => toggleGroup('household')}>{t('finances.household')}</ScopeBubble>
                )}
              </div>
              {soleMember && soleMember.konten.length > 1 && (
                <div className="scrollbar-none -mx-1 mt-1.5 flex gap-1.5 overflow-x-auto px-1 py-0.5">
                  {soleMember.konten.map(k => (
                    <ScopeBubble key={k.id} small active={!exclKonten.has(k.id)} onClick={() => toggleKonto(k.id)}>{k.name}</ScopeBubble>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* The assistant restated the question and set the filters above. Every figure in
          here is read from the deterministic endpoints, never from the model. */}
      {aiAnswer && (
        <Card className="flex flex-col gap-2 border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900 dark:bg-emerald-950/20">
          <div className="flex items-start gap-2">
            <Sparkles size={16} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <p className="min-w-0 flex-1 text-sm text-zinc-700 dark:text-zinc-200">
              {aiAnswer.clarify ?? aiAnswer.answer ?? t('stats.aiApplied')}
            </p>
            <button onClick={() => setAiAnswer(null)} title={t('common.close')} className="shrink-0 text-zinc-400 hover:text-zinc-600"><X size={16} /></button>
          </div>
          {(aiAnswer.category_label || aiAnswer.canonicals.length > 0 || (aiAnswer.from && aiAnswer.to) || aiAnswer.konto_ids.length > 0) && (
            <div className="flex flex-wrap gap-1.5 pl-6">
              {aiAnswer.category_label && <span className="rounded-full bg-white px-2 py-0.5 text-xs text-zinc-600 ring-1 ring-emerald-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-emerald-900">{aiAnswer.category_label}</span>}
              {/* One chip per article so it stays transparent which articles were grouped. */}
              {aiAnswer.canonicals.map(c => <span key={c} className="rounded-full bg-white px-2 py-0.5 text-xs text-zinc-600 ring-1 ring-emerald-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-emerald-900">{c}</span>)}
              {aiAnswer.from && aiAnswer.to && <span className="rounded-full bg-white px-2 py-0.5 text-xs text-zinc-600 ring-1 ring-emerald-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-emerald-900">{fmtDate(aiAnswer.from, i18n.language)} – {fmtDate(aiAnswer.to, i18n.language)}</span>}
              {aiAnswer.konto_ids.map(id => {
                const k = (konten ?? []).find(x => x.id === id);
                return k ? <span key={id} className="rounded-full bg-white px-2 py-0.5 text-xs text-zinc-600 ring-1 ring-emerald-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-emerald-900">{k.name}</span> : null;
              })}
            </div>
          )}
          {/* An account the model named that this page's person/household bubbles cannot
              express (cash, or an account linked to no member). Named out loud, because the
              alternative — quietly widening the view to every account — answers a different
              question than the one that was asked. */}
          {aiAnswer.droppedKonten.length > 0 && (
            <p className="pl-6 text-xs text-amber-700 dark:text-amber-400">
              {t('finances.aiKontoNote', { konten: aiAnswer.droppedKonten.map(id => (konten ?? []).find(x => x.id === id)?.name ?? `#${id}`).join(', ') })}
            </p>
          )}
          {/* No "the lists below show another period" note any more: a multi-month answer
              now switches the whole page to that window, so the card and everything under
              it are one period. */}
          {aiAnswer.category_path && (() => {
            const node = nodeByPath.get(aiAnswer.category_path!);
            if (!node) return null;
            return <AiCategoryCard node={node} onOpen={() => openPositions(node.label, node.path)} />;
          })()}
          {aiAnswer.canonicals.length > 0 && (() => {
            const label = aiAnswer.group_label ?? aiAnswer.canonicals.join(', ');
            return (
              <AiArticleCard canonicals={aiAnswer.canonicals} label={label} month={month} range={pageRange} kParam={kontenParam}
                onOpen={() => openDrill({ kind: 'article', canonicals: aiAnswer.canonicals, label })} />
            );
          })()}
        </Card>
      )}

      {/* Live search results: matching categories (→ their positions) and matching
          articles (→ their own purchases, not their whole category). */}
      {searchLc && (
        <Card className="flex flex-col p-2">
          {catHits.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-zinc-400">{t('stats.categories')}</div>
              {catHits.map(n => (
                <button key={n.path} onClick={() => openPositions(n.label, n.path)}
                  className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  {n.emoji && <span>{n.emoji}</span>}
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  <span className="tabular shrink-0 text-sm">{eur(n.actual)}</span>
                </button>
              ))}
            </>
          )}
          {articleHits.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-zinc-400">{t('stats.articles')}</div>
              {articleHits.map(a => (
                <button key={a} onClick={() => openDrill({ kind: 'article', canonicals: [a], label: a })}
                  className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900">
                  <span className="min-w-0 flex-1 truncate text-sm">{a}</span>
                  <BarChart3 size={14} className="shrink-0 text-zinc-400" />
                </button>
              ))}
            </>
          )}
          {!catHits.length && !articleHits.length && <EmptyState>{t('stats.noData')}</EmptyState>}
        </Card>
      )}

      {data && (
        <>
          {/* Section order = how often you look: the variable side is the living part of
              the month (open), the plans below it get ticked off once and stay folded. */}
          <Section title={t('finances.varTitle')}>
            {/* One-offs are single-MONTH entries with a per-month check state, so they only
                exist in month mode (the backend returns none for a range anyway). */}
            {!dataRanged && oneOffCosts.map(fixRow)}

            {/* The DERIVED category tree. Nothing here is stored except the optional
                limits: every category shows up with its real spend, and deleting a goal
                never makes a category (or its spend) disappear. divide-y separates the
                top-level groups only — inside a group the indentation carries the
                structure, exactly as it did on the Statistik page. */}
            <Card className="flex flex-col divide-y divide-zinc-100 px-1.5 py-1 dark:divide-zinc-800/70">
              {(childrenOf.get(null) ?? []).map(renderNode)}
              {!treeNodes.length && <EmptyState>{t('stats.noData')}</EmptyState>}
            </Card>

            {/* Lenses: budgets over several categories and/or single articles. They
                OVERLAP the tree on purpose, so they get their own block and are not
                counted a second time in Variable Kosten. */}
            {lenses.length > 0 && (
              <Card className="flex flex-col gap-2 border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900/60 dark:bg-violet-950/20">
                <div>
                  <div className="text-sm font-semibold">{t('finances.lensTitle')}</div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('finances.lensHint')}</div>
                </div>
                <div className="flex flex-col gap-1.5">
                  {lenses.map(l => (
                    <LensRow key={l.id} l={l} t={t} scopedToPerson={!isAll} ranged={dataRanged}
                      onOpen={() => setPosTarget({ label: l.label, q: `budget=${l.id}`, bases: l.categories })}
                      onChart={() => openDrill(lensTarget(l))}
                      onEdit={() => setBudgetModal({ id: l.id, kind: 'lens', lockKind: true, label: l.label, monthly_target: l.monthly_target, konto_id: l.konto_id, categories: l.categories, articles: l.articles })} />
                  ))}
                </div>
              </Card>
            )}

            {/* Limits whose category was renamed/removed by a category redesign. They keep
                working (the prefix still matches whatever artikel still carry that path)
                but they have no row in the tree, so they need re-pointing. A stored monthly
                limit is target-shaped, so this maintenance card sits out range mode. */}
            {!dataRanged && orphanLimits.length > 0 && (
              <Card className="flex flex-col gap-2 border-amber-200 bg-amber-50/50 p-3 dark:border-amber-900/60 dark:bg-amber-950/20">
                <div>
                  <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">{t('finances.orphanTitle')}</div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('finances.orphanHint')}</div>
                </div>
                {orphanLimits.map(o => (
                  <div key={o.id} className="flex items-center gap-2">
                    <button onClick={() => setPosTarget({ label: o.label, q: `budget=${o.id}`, bases: [o.category_path] })}
                      className="flex min-w-0 flex-1 flex-col text-left">
                      <span className="truncate text-sm font-medium">{o.label}</span>
                      <span className="truncate text-[11px] text-zinc-400">{o.category_path}</span>
                    </button>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{eur(o.actual)}</span>
                    <button onClick={() => setBudgetModal({ id: o.id, kind: 'category', lockKind: true, label: o.label, monthly_target: o.monthly_target, konto_id: o.konto_id, categories: [o.category_path], articles: [] })}
                      title={t('finances.reattach')}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
                      <Pencil size={15} />
                    </button>
                  </div>
                ))}
              </Card>
            )}

            {/* Three of the tiles below complete the tree into the period's total:
                  variableTotal = tree total + Kategorie fehlt + Unbekannte Kategorie + Beleg fehlt
                Unbudgetiert is NOT part of that identity — it is a slice OF the tree
                (spend in categories that carry no limit), shown so a goal-less corner of
                the period stays visible. The deep links carry the window the tile was
                computed for (periodFrom/periodTo), which in range mode is that range. */}
            {unbudgeted > 0 && (
              <Card onClick={() => navigate(`/warenstamm/positionen?nobudget=1&from=${periodFrom}&to=${periodTo}`)}
                className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{t('finances.unbudgeted')}</div>
                  <div className="text-xs text-zinc-400">{t('finances.unbudgetedHint')}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-sm font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">{eur(unbudgeted)}</span>
                  <ChevronRight size={16} className="text-zinc-400" />
                </div>
              </Card>
            )}
            {categoryMissing > 0 && (
              <Card onClick={() => navigate(`/warenstamm/positionen?uncat=1&from=${periodFrom}&to=${periodTo}`)}
                className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('finances.categoryMissing')}</div>
                  <div className="text-xs text-zinc-400">{t('finances.categoryMissingHint')}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-sm font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">{eur(categoryMissing)}</span>
                  <ChevronRight size={16} className="text-zinc-400" />
                </div>
              </Card>
            )}
            {/* Spend on a category_path that is no longer in the catalogue. It cannot sit
                in any tree row, so without this tile the tree would silently fail to add
                up to Variable Kosten. Not tappable: there is no filter for "dangling
                category" — the fix is a recategorize run, not a positions list. */}
            {unknownCategory > 0 && (
              <Card className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('finances.unknownCategory')}</div>
                  <div className="text-xs text-zinc-400">{t('finances.unknownCategoryHint')}</div>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">{eur(unknownCategory)}</span>
              </Card>
            )}
            {/* The Auszüge deep-link filters by MONTH (bm=YYYY-MM), so over a window there
                is no link that would land on the same set of debits — the tile then states
                its number and nothing more, like Unbekannte Kategorie above. The hint has
                to drop its "tippen zum Ansehen" with it: the chevron and the click handler
                are gone, so leaving the invitation would be advertising a tap that does
                nothing. Keyed on the payload, like the link it describes — `bm=${month}`
                only names the right debits when this payload IS that month's. */}
            {receiptMissing > 0 && (
              <Card onClick={dataRanged ? undefined : () => navigate(`/finanzen?tab=bank&bs=open&bm=${month}`)}
                className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-amber-700 dark:text-amber-400">{t('finances.receiptMissing')}</div>
                  <div className="text-xs text-zinc-400">
                    {t(dataRanged ? 'finances.receiptMissingHintRange' : 'finances.receiptMissingHint', { count: receiptMissingCount })}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-sm font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">{eur(receiptMissing)}</span>
                  {!dataRanged && <ChevronRight size={16} className="text-zinc-400" />}
                </div>
              </Card>
            )}

            {/* Bottom of the list, not the section header: a category goal is set on its
                own row now, so this button is for the overlapping kind you add rarely. It
                creates a MONTHLY target, so it belongs to month mode. */}
            {!dataRanged && (
              <Button variant="secondary" className="w-full justify-center py-2 text-xs"
                onClick={() => setBudgetModal({ kind: 'lens', categories: [], articles: [] })}>
                <Plus size={14} /> {t('finances.addBudget')}
              </Button>
            )}
          </Section>

          {/* The three plan sections are per-MONTH recurring rows with a per-month check
              state; summing them over a window that ends mid-month would invent a number
              nobody could defend, so a range simply does not show them. */}
          {!dataRanged && (
            <>
              {/* Fixed costs — recurring expense plans (rent, internet, subscriptions) */}
              <Section title={t('finances.fixTitle')} count={fixedCosts.length} defaultOpen={false}>
                {!fixedCosts.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noFixThisMonth')}</Card>}
                {fixedCosts.map(fixRow)}
              </Section>

              {/* Variable income — one-off incomes (generated single-month, e.g. "…Spesen") */}
              <Section title={t('finances.varIncomeTitle')} count={varIncome.length} defaultOpen={false}>
                {!varIncome.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noVarIncome')}</Card>}
                {varIncome.map(fixRow)}
              </Section>

              {/* Fixed income — recurring income plans (salary, Kindergeld, Beiträge) */}
              <Section title={t('finances.fixedIncomeTitle')} count={fixedIncome.length} defaultOpen={false}>
                {!fixedIncome.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noIncomePlans')}</Card>}
                {fixedIncome.map(fixRow)}
              </Section>
            </>
          )}
        </>
      )}

      {picker && (
        <ReceiptPicker month={month} fix={picker} onClose={() => setPicker(null)}
          onPick={async (ev, amount) => {
            if (!Object.keys(ev).length) return;                       // nothing selected → no-op
            if (!(await okDelta(picker, amount))) return;
            // Close only on success (check.onSuccess → invalidate + setPicker(null));
            // on failure the picker stays open and an error toast shows.
            check.mutate({ fixed_cost_id: picker.id, month, action: 'confirm', ...ev });
          }} />
      )}
      {budgetModal && <BudgetModal initial={budgetModal} onClose={() => setBudgetModal(null)} onSaved={invalidate} />}
      {posTarget && <PositionsModal target={posTarget} month={month} range={pageRange} konten={kontenParam} onClose={() => setPosTarget(null)} />}
      {/* Keyed on scope+range: opening a DIFFERENT drill-down while one is on screen (the
          assistant's answer card can do that) must remount, or the modal would keep the
          period state of the target it no longer shows.
          Tapping a month in its chart jumps the WHOLE page there, which means leaving range
          mode too — otherwise the page would stay pinned to a window that the month it just
          jumped to is nowhere in. One setPeriod, not clearRange()+setMonth(): as two URL
          writes in one tick the second would rebuild from the pre-clear params and hand the
          window straight back. */}
      {drill && <SpendingDrilldown key={`${spendScopeKey(drill.target)}|${drill.range?.from ?? ''}|${drill.range?.to ?? ''}`}
        target={drill.target} month={month} initialRange={drill.range} kParam={kontenParam}
        onClose={() => setDrill(null)} onPickMonth={ym => setPeriod({ m: ym, from: '', to: '' })} />}
      {evidence && <FixedEvidenceModal id={evidence.id} label={evidence.label} kind={evidence.kind} month={month} t={t}
        expectReceipt={evidence.expectReceipt}
        onClose={() => setEvidence(null)}
        onNoReceipt={() => { expectReceiptOff.mutate(evidence.id); setEvidence(e => e && { ...e, expectReceipt: false }); }}
        onExpectReceiptOn={() => { expectReceiptOn.mutate(evidence.id); setEvidence(e => e && { ...e, expectReceipt: true }); }}
        onFindReceipt={() => {
          const list = evidence.kind === 'income' ? (data?.incomes ?? []) : (data?.fixed ?? []);
          const f = list.find(x => x.id === evidence.id);
          setEvidence(null);
          if (f) setPicker(f);
        }}
        onEndPlan={() => {
          const msg = evidence.kind === 'income' ? t('finances.evEndIncomeConfirm', { label: evidence.label }) : t('finances.evEndFixedConfirm', { label: evidence.label });
          if (!window.confirm(msg)) return;
          endPlan.mutate(evidence.id);
          setEvidence(null);
        }} />}
    </div>
  );
}

interface FixEvidence {
  status: string | null; amount: number | null;
  bank: { id: number; datum: string; amount: number; counterparty: string | null; private: boolean } | null;
  receipt: { id: number | null; laden: string | null; datum: string; betrag: number; quelle: string; private: boolean } | null;
  income: { id: number; datum: string; description: string | null; amount: number; has_file: boolean; file_name: string | null } | null;
}

/** Click a confirmed Fixkosten row → see the full evidence chain: the bank booking
 *  AND the receipt/e-mail (or income), whichever — or both — is attached. Each is a
 *  link (bank → Auszüge search, receipt → its detail page). */
function FixedEvidenceModal({ id, label, kind, month, t, expectReceipt, onClose, onNoReceipt, onExpectReceiptOn, onFindReceipt, onEndPlan }: {
  id: number; label: string; kind: 'expense' | 'income'; month: string; t: (k: string, o?: Record<string, unknown>) => string;
  expectReceipt: boolean; onClose: () => void; onNoReceipt: () => void; onExpectReceiptOn: () => void; onFindReceipt: () => void; onEndPlan: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [viewPayslip, setViewPayslip] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['fix-evidence', id, month],
    queryFn: () => api<FixEvidence>(`/api/finances/fixed-cost/${id}/evidence?month=${month}`),
  });
  // Attach a pay slip to the linked income row (income "receipt"), mirroring the
  // Verwaltung income list — so income evidence has the same proof flow as fixed costs.
  const attach = useMutation({
    mutationFn: async ({ id: incId, file }: { id: number; file: File }) => {
      const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('read failed')); r.readAsDataURL(file); });
      return api(`/api/finances/income/${incId}/file`, { method: 'POST', body: { filename: file.name, data_b64: b64 } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fix-evidence'] }); void qc.invalidateQueries({ queryKey: ['fin-month'] }); void qc.invalidateQueries({ queryKey: ['fin-income'] }); toast(t('finances.income.attached'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // Detach a single evidence leg (bank statement / receipt / income) from this month.
  const unlink = useMutation({
    mutationFn: (leg: 'bank' | 'receipt' | 'income') => api(`/api/finances/fixed-cost/${id}/evidence/unlink`, { method: 'POST', body: { month, leg } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fix-evidence'] }); void qc.invalidateQueries({ queryKey: ['fin-month'] }); toast(t('finances.evUnlinked'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const go = (to: string) => { onClose(); navigate(to); };
  const rowCls = 'flex items-center gap-3 rounded-xl border border-zinc-200 p-3 text-left dark:border-zinc-800';
  return (
    <>
    <Modal open onClose={onClose} title={label}>
      <div className="flex flex-col gap-2.5">
        {isLoading ? <Spinner /> : !data ? <p className="text-xs text-zinc-400">–</p> : (
          <>
            <p className="text-xs text-zinc-400">{t('finances.evidenceIntro')}</p>
            {/* Bank booking — the source of truth. Only a link when there's a
                counterparty to search Auszüge by (else it would land unfiltered). */}
            {data.bank ? (() => { const bankLink = !data.bank.private && !!data.bank.counterparty; return (
              <div className={rowCls}>
                <button type="button" disabled={!bankLink} onClick={() => bankLink && go(`/finanzen?tab=bank&bq=${encodeURIComponent(data.bank!.counterparty!)}&bhl=${data.bank!.id}`)}
                  className={cn('flex min-w-0 flex-1 items-center gap-3 text-left', bankLink && 'hover:opacity-75')}>
                  <Landmark size={18} className="shrink-0 text-sky-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.evidenceBank')}</div>
                    <div className="truncate text-sm">{data.bank.private ? t('finances.privatePurchase') : (data.bank.counterparty || '—')}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold">{eur(data.bank.amount)}</div>
                    <div className="text-[10px] text-zinc-400">{ddmmyyyy(data.bank.datum)}</div>
                  </div>
                  {bankLink && <ChevronRight size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
                </button>
                {!data.bank.private && <button type="button" onClick={() => unlink.mutate('bank')} disabled={unlink.isPending} title={t('finances.evUnlink')}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Link2Off size={15} /></button>}
              </div>); })()
            : (
              // No bank booking this month → either find the statement, or the plan
              // is no longer active (end it at the end of the previous month).
              <div className="rounded-xl border border-dashed border-zinc-200 p-3 dark:border-zinc-800">
                <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400"><Landmark size={14} /> {t('finances.evidenceNoBank')}</div>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={onFindReceipt} className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700">{t('finances.evFindBank')}</button>
                  <button type="button" onClick={onEndPlan} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">{kind === 'income' ? t('finances.evEndIncome') : t('finances.evEndFixed')}</button>
                </div>
              </div>
            )}
            {/* Receipt / e-mail invoice (expense) */}
            {kind === 'expense' && data.receipt && (
              <div className={rowCls}>
                <button type="button" disabled={data.receipt.private || data.receipt.id == null}
                  onClick={() => data.receipt?.id != null && go(`/receipts/${data.receipt.id}`)}
                  className={cn('flex min-w-0 flex-1 items-center gap-3 text-left', !data.receipt.private && data.receipt.id != null && 'hover:opacity-75')}>
                  {data.receipt.private ? <Lock size={18} className="shrink-0 text-zinc-400" /> : <Receipt size={18} className="shrink-0 text-emerald-500" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.evidenceReceipt')}</div>
                    <div className="truncate text-sm">{data.receipt.private ? t('finances.privatePurchase') : (data.receipt.laden || '—')}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold">{eur(data.receipt.betrag)}</div>
                    <div className="text-[10px] text-zinc-400">{ddmmyyyy(data.receipt.datum)}</div>
                  </div>
                  {!data.receipt.private && data.receipt.id != null && <ChevronRight size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
                </button>
                {!data.receipt.private && <button type="button" onClick={() => unlink.mutate('receipt')} disabled={unlink.isPending} title={t('finances.evUnlink')}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Link2Off size={15} /></button>}
              </div>
            )}
            {/* Income row (pay slip) — the proof for an income plan; view / attach here */}
            {kind === 'income' && data.income && (
              <div className={rowCls}>
                <Wallet size={18} className="shrink-0 text-teal-500" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.evidenceIncome')}</div>
                  <div className="truncate text-sm">{data.income.description || '—'}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold">{eur(data.income.amount)}</div>
                  <div className="text-[10px] text-zinc-400">{ddmmyyyy(data.income.datum)}</div>
                </div>
                {data.income.has_file ? (
                  <button type="button" onClick={() => setViewPayslip(true)} title={t('finances.income.view')}
                    className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"><FileText size={16} /></button>
                ) : (
                  <label className="shrink-0 cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800" title={t('finances.income.attach')}>
                    <Paperclip size={16} />
                    <input type="file" accept=".pdf,image/*" className="hidden" onChange={e => { const fl = e.target.files?.[0]; const inc = data.income; if (fl && inc) attach.mutate({ id: inc.id, file: fl }); e.currentTarget.value = ''; }} />
                  </label>
                )}
                <button type="button" onClick={() => unlink.mutate('income')} disabled={unlink.isPending} title={t('finances.evUnlink')}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Link2Off size={15} /></button>
              </div>
            )}
            {/* Proof resolution: find, (income) attach above, or mark "kein Beleg" (undo-able) */}
            {(() => {
              const hasProof = kind === 'expense' ? !!data.receipt : !!(data.income && data.income.has_file);
              if (hasProof) return null;
              if (expectReceipt === false) return (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-zinc-200 p-3 dark:border-zinc-800">
                  <span className="inline-flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400"><CheckCircle2 size={14} className="shrink-0 text-zinc-400" /> {t('finances.evNoReceiptState')}</span>
                  <button type="button" onClick={onExpectReceiptOn} className="shrink-0 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">{t('finances.evExpectReceiptOn')}</button>
                </div>
              );
              const canFind = kind === 'expense' ? !data.receipt : !data.income;
              return (
                <div className="rounded-xl border border-dashed border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400"><Receipt size={14} /> {kind === 'income' ? t('finances.evidenceNoProof') : t('finances.evidenceNoReceipt')}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {canFind && <button type="button" onClick={onFindReceipt} className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700">{kind === 'income' ? t('finances.evFindIncome') : t('finances.evFindReceipt')}</button>}
                    <button type="button" onClick={onNoReceipt} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">{t('finances.evNoReceiptNeeded')}</button>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>
    </Modal>
    {viewPayslip && data?.income && <PayslipViewer id={data.income.id} name={data.income.file_name ?? ''} t={t} onClose={() => setViewPayslip(false)} />}
    </>
  );
}

function FixCheckRow({ f, t, excluded, onConfirmSuggestion, onClear, onShowEvidence }: {
  f: MonthFix; month: string; t: (k: string, o?: Record<string, unknown>) => string; excluded?: boolean;
  onConfirmSuggestion: () => void; onClear: () => void;
  onShowEvidence: () => void;
}) {
  const delta = f.check?.amount != null ? Math.round((f.check.amount - f.monthly_eur) * 100) / 100 : null;
  const periodic = f.frequency && f.frequency !== 'monthly';
  const shownAmount = periodic ? amortized(f.monthly_eur, f.frequency) : f.monthly_eur;
  const skipped = f.check?.status === 'skipped';
  const hasCheck = !!f.check;
  // Reconciliation state (backend decides `complete` = bank linked + receipt resolved):
  //   done      → fully reconciled (green)     skipped → deliberately no evidence (grey)
  //   incomplete→ check exists but a leg is still missing (amber, → Nachweis-Modal)
  //   suggest   → an auto match is offered (amber)   open → nothing yet (grey)
  // Everything except done/skipped stays actionable ("Verknüpfen") — including a
  // no-receipt/transfer plan whose bank booking still needs to be linked.
  const rstate: 'done' | 'skipped' | 'incomplete' | 'suggest' | 'open' =
    skipped ? 'skipped' : f.complete ? 'done' : hasCheck ? 'incomplete' : f.suggestion ? 'suggest' : 'open';
  const actionable = rstate !== 'done' && rstate !== 'skipped';
  const IconEl = rstate === 'done' || rstate === 'skipped' ? CheckCircle2
    : rstate === 'incomplete' ? AlertCircle : rstate === 'suggest' ? CircleDot : Circle;
  return (
    // The whole row is the single entry point → opens the one evidence menu (no
    // separate "link" button). Inner action buttons stopPropagation.
    <Card onClick={onShowEvidence} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShowEvidence(); } }}
      className="flex cursor-pointer flex-col gap-2 p-3 transition hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30">
      <div className="flex items-center gap-2.5">
        <IconEl size={18} className={cn('shrink-0',
          rstate === 'done' && 'text-emerald-500', rstate === 'skipped' && 'text-zinc-400',
          (rstate === 'incomplete' || rstate === 'suggest') && 'text-amber-500',
          rstate === 'open' && 'text-zinc-300 dark:text-zinc-600')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{f.label}</span>
            <span className="shrink-0 text-xs text-zinc-400">{scopeLabelOf(t, f)}</span>
            {f.is_transfer && <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{t('finances.transferBadge')}</span>}
            {f.one_off && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{t('finances.oneOffBadge')}</span>}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {rstate === 'skipped' && t('finances.skippedMonth')}
            {hasCheck && !skipped && f.check!.source !== 'none' && (
              <button type="button" onClick={onShowEvidence} className="inline-flex items-center gap-1 text-left hover:text-zinc-700 hover:underline dark:hover:text-zinc-200" title={t('finances.showEvidence')}>
                {f.check!.source === 'bank' ? t('finances.bankShort') : f.check!.source === 'income' ? t('finances.incomeShort') : t('finances.receiptShort')} {f.check!.datum} „{f.check!.laden}“ · {eur(f.check!.amount)}{delta != null && Math.abs(delta) >= 0.01 && <span className={cn('ml-1', delta > 0 ? 'text-amber-600' : 'text-emerald-600')}>Δ {delta > 0 ? '+' : ''}{eur(delta)}</span>}
                <ChevronRight size={12} className="shrink-0 text-zinc-400" />
              </button>)}
            {rstate === 'suggest' && f.suggestion && (
              <>{t('finances.suggestion')} „{f.suggestion.laden}“ {eur(f.suggestion.betrag)} · {f.suggestion.datum.slice(8, 10)}.{f.suggestion.datum.slice(5, 7)}.{f.suggestion.source === 'bank' && <Badge className="ml-1.5">{t('finances.bankBadge')}</Badge>}</>
            )}
            {rstate === 'open' && (f.expect_receipt === false || f.is_transfer ? t('finances.noReceiptBankOpen') : f.kind === 'income' ? t('finances.noIncomeFound') : t('finances.noReceiptFound'))}
            {/* Amber to-do chip names the leg that's actually missing: the bank booking
                (the usual case) or, once that's linked, the receipt/proof. */}
            {rstate === 'incomplete' && <button type="button" onClick={onShowEvidence} className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300">{t(!f.bank_linked ? 'finances.bankOpen' : f.kind === 'income' ? 'finances.proofOpen' : 'finances.receiptOpen')}</button>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn('text-sm font-semibold', excluded && 'text-zinc-400 line-through')}>{eur(shownAmount)}</div>
          {periodic && <div className="text-[10px] text-zinc-400">{eur(f.monthly_eur)} {t(`finances.freqPer.${f.frequency}`)}</div>}
          {excluded && <div className="text-[10px] text-violet-500">{t('finances.notCounted')}</div>}
        </div>
      </div>
      {actionable && (
        <div className="flex flex-wrap gap-1.5 pl-7" onClick={e => e.stopPropagation()}>
          {rstate === 'suggest' && <Button className="px-2.5 py-1 text-xs" onClick={onConfirmSuggestion}>{t('finances.confirm')}</Button>}
          {hasCheck && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={onClear}>{t('finances.reopen')}</Button>}
        </div>
      )}
    </Card>
  );
}

/** Spend-against-goal bar. Only ever rendered when a goal actually exists — a category
 *  without one shows the words "kein Ziel" instead, never an empty bar at 0,00. */
function TargetBar({ actual, target, className }: { actual: number; target: number; className?: string }) {
  const pct = (actual / target) * 100;
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800', className)}>
      <div className={cn('h-full rounded-full transition-all', pct > 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500')}
        style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

/** Icon hit area. 36×36 so the three targets on one tree row (positions / chart / goal)
 *  stay comfortably apart under a thumb. */
const iconBtn = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300';

/** One row of the derived category tree. Three separate hit areas: the row itself opens
 *  the positions list, 📊 opens spending-over-time, ✏️ edits the (optional) limit — plus
 *  the chevron when the node has children.
 *  `ranged` = the page is on a from/to window instead of a month. Everything target-shaped
 *  then goes away — a monthly goal, its bar, the "median of the 3 prior months" forecast
 *  and the ✏️ that sets them all describe a MONTH, and pro-rating any of them onto an
 *  arbitrary window would be an invented number. The row keeps what it can prove: the
 *  category, its spend for the window, and the drill-down. */
function CategoryRow({ n, t, hasKids, open, scopedToPerson, ranged, onToggle, onOpen, onChart, onEdit, onEditExtra }: {
  n: MonthCategoryNode; t: (k: string, o?: Record<string, unknown>) => string;
  hasKids: boolean; open: boolean; scopedToPerson: boolean; ranged: boolean;
  onToggle: () => void; onOpen: () => void; onChart: () => void; onEdit: () => void;
  onEditExtra: (l: BudgetLimit) => void;
}) {
  const limit = n.limit;
  // A household-wide goal viewed under a single-person scope has no per-person target, so
  // the goal is shown for context but the bar is dropped: comparing one person's spend to
  // the household goal is apples to oranges (the rule the old budget tiles used too).
  const scopedOut = scopedToPerson && limit != null && limit.konto_id == null;
  const target = limit?.monthly_target ?? null;
  // A limit tied to ONE account tracks that account's spend (the backend narrows it), so
  // its bar must measure `limit.actual`, not the node's — otherwise a personal 50 € goal
  // looks blown the moment the household spends 200 € in that category.
  const personal = limit != null && limit.konto_id != null;
  const limitActual = personal ? limit!.actual : n.actual;
  const pct = !ranged && target != null && target > 0 && !scopedOut ? (limitActual / target) * 100 : null;
  // …and for the same reason the headline € (the node's own number) only turns red when
  // the goal it is being measured against is the household-wide one.
  const headlineOver = pct != null && pct > 100 && !personal;

  // Second line, assembled from whatever is true for this node. In range mode only the
  // meta hint qualifies — everything else on this line describes a month.
  const bits: string[] = [];
  if (n.is_meta) bits.push(t('finances.metaHint'));   // true over any period
  else if (!ranged) {
    if (!limit || target == null) bits.push(t('finances.noTarget'));
    else {
      bits.push(`${t('finances.target')}: ${eur(target)}`);
      // Name the person AND their number — the headline shows the whole scope's spend.
      if (personal) bits.push(`${scopeLabelOf(t, limit)}: ${eur(limit.actual)}`);
      else if (scopedToPerson) bits.push(t('finances.wholeHousehold'));
    }
    // The forecast has to be measured the same way as the target and the Ist standing next
    // to it: a personal limit gets the backend's konto-narrowed `limit.forecast`, not the
    // node's household-wide one — otherwise a row reading "Ziel 80 · Martin 62" would end
    // in the whole household's 610 and look like a goal about to be blown by half a grand.
    const forecast = personal ? limit!.forecast : n.forecast;
    if (forecast != null) bits.push(`${t('finances.forecast')}: ${eur(forecast)}`);
  }

  return (
    <div className="rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-900/60" style={{ paddingLeft: `${(n.level - 1) * 12}px` }}>
      <div className="flex items-center gap-0.5">
        {hasKids ? (
          <button onClick={onToggle} aria-expanded={open} title={t('finances.toggleSub')}
            className="flex h-9 w-7 shrink-0 items-center justify-center text-zinc-400">
            <ChevronDown size={15} className={cn('transition-transform', !open && '-rotate-90')} />
          </button>
        ) : <span className="h-9 w-7 shrink-0" />}
        <button onClick={onOpen} title={t('finances.showPositions')} className="flex min-w-0 flex-1 flex-col py-1.5 text-left">
          <span className="flex items-baseline gap-1.5">
            {n.emoji && <span className="shrink-0">{n.emoji}</span>}
            <span className={cn('truncate text-sm', n.level === 1 && 'font-semibold')}>{n.label}</span>
          </span>
          {bits.length > 0 && <span className="mt-0.5 truncate text-[11px] text-zinc-400">{bits.join(' · ')}</span>}
        </button>
        <span className={cn('shrink-0 px-1 text-sm font-semibold tabular-nums', headlineOver && 'text-red-600 dark:text-red-400')}>{eur(n.actual)}</span>
        <button onClick={onChart} title={t('stats.history')} className={iconBtn}><BarChart3 size={15} /></button>
        {/* Pfand & Rabatt are bookkeeping counter-entries that make the total equal what
            was actually paid — a spending goal on them is meaningless, so no ✏️ there. */}
        {!n.is_meta && !ranged && (
          <button onClick={onEdit} title={t(limit ? 'common.edit' : 'finances.setTarget')} className={iconBtn}>
            <Pencil size={15} />
          </button>
        )}
      </div>
      {pct != null && <TargetBar actual={limitActual} target={target!} className="mb-1.5 ml-7 mr-1" />}
      {/* Legacy duplicates: a household-wide AND a personal limit on the same path. The
          backend keeps both on purpose (100 adds no UNIQUE index, which could have failed
          on live data) and POST refuses to recreate one (409), so each needs its own ✏️ —
          a bare "+1 weiteres Ziel" would name a row nobody could open, edit or delete. */}
      {!ranged && !!n.extra_limits?.length && (
        <div className="mb-1.5 ml-7 mr-1 flex flex-col">
          <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
            {t('finances.extraLimits', { count: n.extra_limits.length })}
          </span>
          {n.extra_limits.map(x => (
            <div key={x.id} className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {x.label} · {x.konto_id != null ? scopeLabelOf(t, x) : t('finances.wholeHousehold')}
                {x.monthly_target != null && ` · ${t('finances.target')}: ${eur(x.monthly_target)}`}
                {` · ${eur(x.actual)}`}
              </span>
              <button onClick={() => onEditExtra(x)} title={t('common.edit')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
                <Pencil size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** /api/spending/history takes ONE category path or a set of canonicals, so a lens is
 *  chartable only when it is purely articles or exactly one category. A mixed lens has
 *  no endpoint that expresses it — better no button than a wrong chart. */
const lensChartable = (l: BudgetLens) => l.articles.length > 0 ? l.categories.length === 0 : l.categories.length === 1;
const lensTarget = (l: BudgetLens): DrillTarget => l.articles.length
  ? { kind: 'article', canonicals: l.articles, label: l.label }
  : { kind: 'category', path: l.categories[0], label: l.label };

/** One overlapping budget (several categories and/or single articles). Same three hit
 *  areas as a tree row, minus the goal-less case: a lens may have no target on purpose
 *  ("what do I actually spend on Energydrinks?"). `ranged` strips it down to label +
 *  spend: over an arbitrary window a monthly target has nothing to measure. */
function LensRow({ l, t, scopedToPerson, ranged, onOpen, onChart, onEdit }: {
  l: BudgetLens; t: (k: string, o?: Record<string, unknown>) => string; scopedToPerson: boolean; ranged: boolean;
  onOpen: () => void; onChart: () => void; onEdit: () => void;
}) {
  const scopedOut = scopedToPerson && l.konto_id == null;
  const pct = !ranged && l.monthly_target != null && l.monthly_target > 0 && !scopedOut ? (l.actual / l.monthly_target) * 100 : null;
  const chartable = lensChartable(l);
  const bits: string[] = [];
  if (!ranged) {
    if (l.monthly_target == null) bits.push(t('finances.noTarget'));
    else {
      bits.push(`${t('finances.target')}: ${eur(l.monthly_target)}`);
      if (l.konto_id != null) bits.push(scopeLabelOf(t, l));
      else if (scopedToPerson) bits.push(t('finances.wholeHousehold'));
    }
  }
  if (l.categories.length) bits.push(l.categories.map(c => c.split('/').pop()).join(', '));
  if (l.articles.length) bits.push(`${t('finances.lensArticles')}: ${l.articles.join(', ')}`);
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-0.5">
        <button onClick={onOpen} title={t('finances.showPositions')} className="flex min-w-0 flex-1 flex-col py-1 text-left">
          <span className="truncate text-sm font-medium">{l.label}</span>
          <span className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">{bits.join(' · ')}</span>
        </button>
        <span className={cn('shrink-0 px-1 text-sm font-semibold tabular-nums', pct != null && pct > 100 && 'text-red-600 dark:text-red-400')}>{eur(l.actual)}</span>
        {chartable && <button onClick={onChart} title={t('stats.history')} className={iconBtn}><BarChart3 size={15} /></button>}
        {!ranged && <button onClick={onEdit} title={t('common.edit')} className={iconBtn}><Pencil size={15} /></button>}
      </div>
      {pct != null && <TargetBar actual={l.actual} target={l.monthly_target!} className="mb-1 mr-1" />}
    </div>
  );
}

interface BudgetPos {
  id: number; name: string | null; preis: number; menge: number | null; einheit: string | null;
  category_path: string | null; einkauf_id: number | null; datum: string | null; laden: string | null;
  private?: boolean;
}
type PosSort = 'date_desc' | 'date_asc' | 'price_desc' | 'price_asc';

// Group a position under the first sub-category below the budget's matched base
// category (budget "Lebensmittel" → groups "Obst & Gemüse", "Milch & Eier", …).
function catGroupOf(catPath: string, bases: string[]): { key: string; label: string } {
  const base = bases.filter(b => catPath === b || catPath.startsWith(b + '/')).sort((a, b) => b.length - a.length)[0];
  if (base == null) return { key: catPath || '—', label: (catPath.split('/').pop() || '—') };
  if (catPath === base) return { key: base, label: (base.split('/').pop() || base) };
  const firstSeg = catPath.slice(base.length + 1).split('/')[0];
  return { key: `${base}/${firstSeg}`, label: firstSeg };
}
const sortPositions = (rs: BudgetPos[], sort: PosSort) => [...rs].sort((a, b) => {
  const ad = a.datum ?? '', bd = b.datum ?? '';
  return sort === 'date_asc' ? (ad < bd ? -1 : ad > bd ? 1 : a.id - b.id)
    : sort === 'date_desc' ? (ad > bd ? -1 : ad < bd ? 1 : b.id - a.id)
      : sort === 'price_asc' ? a.preis - b.preis : b.preis - a.preis;
});

/** One position row. A masked (private) position shows only "Privater Einkauf" +
 *  its amount — no name, store, category, date, and not clickable. Otherwise the
 *  row jumps to its receipt with the item highlighted. */
function PosRow({ p, t, onOpen }: { p: BudgetPos; t: (k: string, o?: Record<string, unknown>) => string; onOpen: (p: BudgetPos) => void }) {
  if (p.private) {
    return (
      <li className="flex shrink-0 items-center gap-2 px-1 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm italic text-zinc-500 dark:text-zinc-400">
          <Lock size={13} className="shrink-0" />
          <span className="truncate">{t('finances.privatePurchase')}</span>
        </div>
        <span className="shrink-0 text-sm font-semibold">{eur(p.preis)}</span>
      </li>
    );
  }
  return (
    <li onClick={() => onOpen(p)} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p); } }}
      title={t('finances.openReceipt')}
      className="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-1 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{p.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
          {p.datum && <span>{ddmmyyyy(p.datum)}</span>}
          {p.laden && <span className="truncate">{p.laden}</span>}
          {p.category_path && <span className="truncate text-zinc-400">{p.category_path.split('/').pop()}</span>}
        </div>
      </div>
      <span className="shrink-0 text-sm font-semibold">{eur(p.preis)}</span>
      <ChevronRight size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />
    </li>
  );
}

/** A collapsible sub-category group; the header shows its total for the month. */
function CatGroup({ g, t, onOpen }: { g: { key: string; label: string; total: number; items: BudgetPos[] }; t: (k: string, o?: Record<string, unknown>) => string; onOpen: (p: BudgetPos) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="shrink-0 overflow-hidden rounded-lg border border-zinc-100 dark:border-zinc-800">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
        <ChevronDown size={14} className={cn('shrink-0 text-zinc-400 transition-transform', !open && '-rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.label}</span>
        <span className="shrink-0 text-xs text-zinc-400">{g.items.length}</span>
        <span className="shrink-0 text-sm font-semibold">{eur(g.total)}</span>
      </button>
      {open && (
        <ul className="border-t border-zinc-100 px-1 dark:border-zinc-800">
          {g.items.map(p => <PosRow key={p.id} p={p} t={t} onOpen={onOpen} />)}
        </ul>
      )}
    </li>
  );
}

/** Drill-down modal: every article position behind the tapped row's Ist for the period —
 *  a category subtree (`path=…`) or a stored limit/lens (`budget=…`). One endpoint for
 *  both, so the list total always equals the figure on the row that was tapped (same
 *  konto scoping, same fixed-cost exclusion, same privacy masking). Positions can be
 *  sorted (date / price) and grouped into sub-categories with per-group totals.
 *  `range` is the page's Zeitraum: /api/finances/positions resolves its window exactly the
 *  way /api/finances/month does, so passing it keeps that equality true over a range too. */
function PositionsModal({ target, month, range, konten, onClose }: {
  target: PosTarget; month: string; range: DateRange | null; konten: string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sort, setSort] = useState<PosSort>('date_desc');
  const [grouped, setGrouped] = useState(false);
  // Both halves or neither — the endpoint reads a lone `from` as a malformed range (400).
  const rangeParam = range ? `&from=${range.from}&to=${range.to}` : '';
  const { data, isLoading } = useQuery({
    // Keyed on the window as well as the scope, or a range would be served the month's rows.
    queryKey: ['fin-positions', target.q, month, rangeParam, konten],
    queryFn: () => api<{ positions: BudgetPos[]; total: number }>(`/api/finances/positions?month=${month}${rangeParam}&${target.q}${konten}`),
  });
  const rows = data?.positions ?? [];
  // Masked (private) positions carry no einkauf_id → not navigable.
  const openReceipt = (p: BudgetPos) => { if (p.private || !p.einkauf_id) return; onClose(); navigate(`/receipts/${p.einkauf_id}?highlight=${p.id}`); };
  const sorted = useMemo(() => sortPositions(rows, sort), [rows, sort]);
  const groups = useMemo(() => {
    const bases = target.bases ?? [];
    const map = new Map<string, { label: string; items: BudgetPos[]; total: number }>();
    for (const p of rows) {
      // Private positions have no category → collect them in one "Privater Einkauf" group.
      const g = p.private ? { key: '__private__', label: t('finances.privatePurchase') } : catGroupOf(p.category_path ?? '', bases);
      const e = map.get(g.key) ?? { label: g.label, items: [] as BudgetPos[], total: 0 };
      e.items.push(p); e.total += p.preis;
      map.set(g.key, e);
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, label: v.label, total: Math.round(v.total * 100) / 100, items: sortPositions(v.items, sort) }))
      .sort((a, b) => b.total - a.total);
  }, [rows, sort, target.bases]);

  return (
    <Modal open onClose={onClose} title={target.label}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">{t('finances.positionsCount', { count: rows.length })}</span>
          <span className="font-semibold">{eur(data?.total ?? 0)}</span>
        </div>
        {rows.length > 0 && (
          <div className="flex items-center gap-2">
            <Select value={sort} onChange={e => setSort(e.target.value as PosSort)} className="min-w-0 flex-1 text-xs">
              <option value="date_desc">{t('finances.sortDateDesc')}</option>
              <option value="date_asc">{t('finances.sortDateAsc')}</option>
              <option value="price_desc">{t('finances.sortPriceDesc')}</option>
              <option value="price_asc">{t('finances.sortPriceAsc')}</option>
            </Select>
            <button onClick={() => setGrouped(g => !g)}
              className={cn('inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium',
                grouped ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300')}>
              <Layers size={14} /> {t('finances.groupByCat')}
            </button>
          </div>
        )}
        {isLoading ? <Spinner /> : rows.length === 0 ? (
          <p className="py-4 text-center text-xs text-zinc-400">{t('finances.positionsEmpty')}</p>
        ) : grouped ? (
          <ul className="-mx-1 flex max-h-[60vh] flex-col gap-1 overflow-y-auto px-1">
            {groups.map(g => <CatGroup key={g.key} g={g} t={t} onOpen={openReceipt} />)}
          </ul>
        ) : (
          <ul className="-mx-1 flex max-h-[60vh] flex-col divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
            {sorted.map(p => <PosRow key={p.id} p={p} t={t} onOpen={openReceipt} />)}
          </ul>
        )}
      </div>
    </Modal>
  );
}

interface HistoryPoint { ym: string; spend: number }
interface SpendItem {
  id: number; name: string | null; canonical_name: string | null; preis: string | null;
  einkauf_id: number; datum: string; roh_ladenname: string | null; member_share?: number;
}
/** Repeated `canonical=` params (never a comma list) so article names containing a comma
 *  survive; a category is one `path=`. Same shape the two /api/spending endpoints want. */
const spendScope = (target: DrillTarget) => target.kind === 'article'
  ? target.canonicals.map(c => `canonical=${encodeURIComponent(c)}`).join('&')
  : `path=${encodeURIComponent(target.path)}`;
const spendScopeKey = (target: DrillTarget) => target.kind === 'article' ? `a:${target.canonicals.join('\n')}` : `c:${target.path}`;
/** The period half of an /api/spending/items call: an explicit date range (both endpoints
 *  have supported from/to all along — it is what makes "wie viel habe ich 2026 für Diesel
 *  ausgegeben" answerable) or the calendar month the page is on. */
const spendPeriod = (month: string, range: DateRange | null) => range
  ? `from=${range.from}&to=${range.to}`
  : `year=${Number(month.slice(0, 4))}&month=${Number(month.slice(5, 7))}`;
/** …and its cache key. Kept identical everywhere so an answer card and the drill-down it
 *  opens share one query instead of fetching the same rows twice. */
const spendPeriodKey = (month: string, range: DateRange | null) => range ? `r:${range.from}:${range.to}` : `m:${month}`;

/** Spending over time — the view a category click opens in the (now absorbed) Statistik
 *  page: 12-month history plus this month's items. It is deliberately the SAME
 *  /api/spending endpoints, so the chart matches Statistik's numbers rather than the
 *  month view's: /api/spending does not subtract receipts already tied to a fixed cost,
 *  which is why the total here can differ from the row's Ist for a category that fixed
 *  costs land in (rent, insurance …). Clicking a month jumps the whole page to it. */
function SpendingDrilldown({ target, month, initialRange, kParam, onClose, onPickMonth }: {
  target: DrillTarget; month: string; initialRange: DateRange | null; kParam: string;
  onClose: () => void; onPickMonth: (ym: string) => void;
}) {
  const { t, i18n } = useTranslation();
  // The PERIOD lives here, not on the page: the month view outside is month-scoped by
  // construction (plans and limits are monthly), while an arbitrary date range is exactly
  // what this view is for — "wie viel habe ich 2026 für Kraftstoff ausgegeben". The
  // assistant pre-fills it when the question spanned several months; otherwise it starts
  // empty and the drill-down follows the page's month, as before.
  const [range, setRange] = useState<DateRange | null>(initialRange);
  const [draft, setDraft] = useState<DateRange>(initialRange ?? { from: '', to: '' });
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const scope = spendScope(target);
  const scopeKey = spendScopeKey(target);
  const periodLabel = range
    ? `${fmtDate(range.from, i18n.language)} – ${fmtDate(range.to, i18n.language)}`
    : monthNameOf(year, mon, i18n.language);

  const { data: history } = useQuery({
    queryKey: ['spending-history', scopeKey, kParam],
    queryFn: () => api<HistoryPoint[]>(`/api/spending/history?${scope}&months=12${kParam}`),
  });
  const { data: items } = useQuery({
    queryKey: ['spending-items', scopeKey, spendPeriodKey(month, range), kParam],
    queryFn: () => api<SpendItem[]>(`/api/spending/items?${scope}&${spendPeriod(month, range)}${kParam}`),
  });
  const total = (items ?? []).reduce((sum, it) => sum + Number(it.member_share ?? it.preis ?? 0), 0);
  // A complete pair switches to range mode; clearing either falls back to the page's month.
  const setBoth = (next: DateRange) => { setDraft(next); setRange(next.from && next.to ? next : null); };

  return (
    <Modal open onClose={onClose} title={target.label} wide>
      <div className="flex flex-col gap-5">
        <div className="flex items-baseline justify-between border-b border-zinc-100 pb-3 dark:border-zinc-800">
          <span className="text-sm text-zinc-500">{periodLabel}</span>
          <span className="tabular text-2xl font-bold">{eur(total)}</span>
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-medium text-zinc-400">{t('stats.dateRange')}</div>
          <div className="flex items-center gap-2">
            <Input type="date" className="min-w-0 flex-1" value={draft.from} onChange={e => setBoth({ ...draft, from: e.target.value })} />
            <span className="shrink-0 text-zinc-400">–</span>
            <Input type="date" className="min-w-0 flex-1" value={draft.to} onChange={e => setBoth({ ...draft, to: e.target.value })} />
            {range && (
              <button onClick={() => { setDraft({ from: '', to: '' }); setRange(null); }} title={t('stats.monthReset')}
                className="shrink-0 rounded-lg p-1 text-zinc-400 hover:text-zinc-600"><X size={16} /></button>
            )}
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium text-zinc-500">{t('stats.history')}</h3>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={history ?? []}
                margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
                // Picking a month has to LEAVE range mode, or the page would jump to a month
                // this modal then refuses to show because a range is still pinned.
                onClick={(e: { activeLabel?: string }) => { if (e?.activeLabel) { setDraft({ from: '', to: '' }); setRange(null); onPickMonth(e.activeLabel); } }}
                className="cursor-pointer"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" />
                <XAxis dataKey="ym" tick={{ fontSize: 10 }} tickFormatter={(ym: string) => ym.slice(5)} />
                <YAxis tick={{ fontSize: 10 }} width={45} tickFormatter={(v: number) => `${v}€`} />
                <Tooltip formatter={(v: number | string) => eur(Number(v))} labelFormatter={l => String(l)} />
                <Line type="monotone" dataKey="spend" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-center text-xs text-zinc-400">{t('stats.tapMonthHint')}</p>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium text-zinc-500">{t('stats.items')} ({periodLabel})</h3>
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {items?.map(it => (
              <Link key={it.id} to={`/receipts/${it.einkauf_id}`} onClick={onClose}
                className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                <span className="min-w-0">
                  <span className="block truncate">{it.canonical_name ?? it.name}</span>
                  <span className="text-xs text-zinc-400">{fmtDate(it.datum, i18n.language)} · {it.roh_ladenname}</span>
                </span>
                <span className="tabular ml-2 shrink-0 font-medium">{eur(it.member_share ?? it.preis)}</span>
              </Link>
            ))}
            {!items?.length && <EmptyState>{t('stats.noData')}</EmptyState>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** € sum for a scope over the assistant's period, straight from the deterministic items
 *  endpoint (never from the model). The query key is the one SpendingDrilldown uses, so
 *  opening the drill-down from an answer card is an instant cache hit. `enabled` keeps it
 *  from firing when the caller already has the number it needs. */
function useSpendTotal(target: DrillTarget, month: string, range: DateRange | null, kParam: string, enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['spending-items', spendScopeKey(target), spendPeriodKey(month, range), kParam],
    queryFn: () => api<SpendItem[]>(`/api/spending/items?${spendScope(target)}&${spendPeriod(month, range)}${kParam}`),
    enabled,
  });
  return (data ?? []).reduce((s, it) => s + Number(it.member_share ?? it.preis ?? 0), 0);
}

/** The assistant's answer card for an article group, over the month or the whole range
 *  the question asked for. */
function AiArticleCard({ canonicals, label, month, range, kParam, onOpen }: {
  canonicals: string[]; label: string; month: string; range: DateRange | null; kParam: string; onOpen: () => void;
}) {
  const total = useSpendTotal({ kind: 'article', canonicals, label }, month, range, kParam, canonicals.length > 0);
  return (
    <button onClick={onOpen}
      className="mt-1 flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-left ring-1 ring-emerald-200 hover:bg-emerald-50 dark:bg-zinc-900 dark:ring-emerald-900 dark:hover:bg-zinc-800">
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <span className="tabular shrink-0 text-lg font-bold">{eur(total)}</span>
    </button>
  );
}

/** The assistant's answer card for a CATEGORY. It shows the page's own figure
 *  (`node.actual`) — which now covers whatever period the page is on, month or range,
 *  because a multi-month answer switches the page to that window. That is deliberately
 *  NOT a second fetch from /api/spending: that endpoint answers slightly differently
 *  (it does not subtract receipts tied to a fixed cost), so the card would contradict
 *  the tree row a few pixels below it. */
function AiCategoryCard({ node, onOpen }: { node: MonthCategoryNode; onOpen: () => void }) {
  return (
    <button onClick={onOpen}
      className="mt-1 flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-left ring-1 ring-emerald-200 hover:bg-emerald-50 dark:bg-zinc-900 dark:ring-emerald-900 dark:hover:bg-zinc-800">
      {node.emoji && <span>{node.emoji}</span>}
      <span className="min-w-0 flex-1 truncate font-medium">{node.label}</span>
      <span className="tabular shrink-0 text-lg font-bold">{eur(node.actual)}</span>
    </button>
  );
}

/** Pick a receipt of the month as evidence for a fixed cost. */
type PickEv = { einkauf_id?: number; income_id?: number; bank_tx_id?: number };
/** Manual evidence picker. For an expense plan it lists the month's invoices
 *  (e-mail/upload). For an income plan it lists income evidence — pay-slip rows
 *  and bank credits — from /income-evidence. onPick returns the id of the chosen
 *  evidence kind. */
function ReceiptPicker({ month, fix, onClose, onPick }: {
  month: string; fix: MonthFix; onClose: () => void; onPick: (ev: PickEv, amount: number | null) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const isIncome = fix.kind === 'income';
  // Two independent selections: a DOCUMENT (invoice / pay slip) and the bank STATEMENT
  // (the actual payment). Pick one from each — or just one — then "Verknüpfen" links
  // both onto the same check, so the row is fully reconciled (Beleg + Bankbuchung).
  // Pre-seed from the existing check so adding one leg never wipes the other (confirm
  // rebuilds the check from the passed ids).
  const [docSel, setDocSel] = useState<{ id: number; amount: number | null } | null>(() => {
    const c = fix.check;
    if (c?.einkauf_id != null) return { id: c.einkauf_id, amount: c.amount };
    if (c?.income_id != null) return { id: c.income_id, amount: c.amount };
    // The check has no document leg → pre-select the deterministic suggestion's doc so
    // the likely match is already green and one "Verknüpfen" confirms it. A PARTIAL
    // check (e.g. income plan with a pay slip but no bank) still gets a suggestion for
    // its missing leg (see the /month isComplete guard), so its bank is pre-picked below.
    const s = fix.suggestion;
    if (s?.source === 'receipt' && s.einkauf_id != null) return { id: s.einkauf_id, amount: s.betrag };
    if (s?.source === 'income' && s.income_id != null) return { id: s.income_id, amount: s.betrag };
    return null;
  });
  const [bankSel, setBankSel] = useState<{ id: number; amount: number | null } | null>(() => {
    const c = fix.check;
    if (c?.bank_tx_id != null) return { id: c.bank_tx_id, amount: c.amount };
    // The check has no bank leg → pre-select the suggested bank statement (green), so an
    // income plan holding only its pay slip gets its Gutschrift pre-picked for 1-click.
    const s = fix.suggestion;
    if (s?.source === 'bank' && s.bank_tx_id != null) return { id: s.bank_tx_id, amount: s.betrag };
    return null;
  });

  // Both kinds return {items:[{source,id,datum,amount,label}]}: income → pay-slip rows
  // + bank credits; expense → invoices + bank debits (wide window for booking lag).
  const evidenceQ = useQuery({
    // freq widens the candidate window to the plan's whole quarter/year so a periodic
    // payment (e.g. a yearly membership charged once) is findable from any month.
    queryKey: ['fin-picker', fix.kind, fix.frequency, month],
    queryFn: () => api<{ items: { source: 'income' | 'bank' | 'receipt'; id: number; datum: string; amount: number; label: string; linked_einkauf_id?: number | null; konto_id?: number | null; konto_name?: string | null }[] }>(
      `/api/finances/${isIncome ? 'income' : 'expense'}-evidence?month=${month}&freq=${fix.frequency}`),
  });
  const isLoading = evidenceQ.isLoading;

  const items = evidenceQ.data?.items ?? [];
  const hit = (l: string) => !q.trim() || l.toLowerCase().includes(q.trim().toLowerCase());
  const docs = items.filter(i => i.source !== 'bank' && hit(i.label));   // invoices / pay-slip rows
  const banks = items.filter(i => i.source === 'bank' && hit(i.label));  // bank statement lines
  const canLink = !!docSel || !!bankSel;
  const doLink = async () => {
    // Linking an invoice to a statement on a DIFFERENT account moves the invoice there (the
    // account that paid it). Confirm the move first so a mis-pick can't silently relocate it.
    if (!isIncome && docSel && bankSel) {
      const docItem = items.find(i => i.source !== 'bank' && i.id === docSel.id);
      const bankItem = items.find(i => i.source === 'bank' && i.id === bankSel.id);
      if (docItem?.konto_id != null && bankItem?.konto_id != null && docItem.konto_id !== bankItem.konto_id) {
        const ok = await confirm({ title: t('receiptDetail.moveKontoTitle'), message: t('receiptDetail.moveKontoMsg', { konto: bankItem.konto_name ?? '?' }), confirmLabel: t('receiptDetail.moveKontoConfirm'), cancelLabel: t('common.cancel') });
        if (!ok) return;
      }
    }
    const ev: PickEv = {};
    if (docSel) { if (isIncome) ev.income_id = docSel.id; else ev.einkauf_id = docSel.id; }
    if (bankSel) ev.bank_tx_id = bankSel.id;
    onPick(ev, docSel?.amount ?? bankSel?.amount ?? null);
  };
  const evRow = (i: { source: string; id: number; datum: string; amount: number; label: string }, selected: boolean, onClick: () => void, linkedTo?: number | null) => (
    // A bank debit already tied to a receipt is that receipt's payment — shown greyed &
    // non-selectable (with a link to it) so you can see where it went, not re-assign it.
    linkedTo ? (
      <div key={`${i.source}:${i.id}`} title={t('finances.pickAlreadyLinked')}
        className="flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 opacity-60 dark:border-zinc-800">
        <span className="w-12 shrink-0 text-xs text-zinc-400">{i.datum?.slice(8, 10)}.{i.datum?.slice(5, 7)}.</span>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-500 dark:text-zinc-400">{i.label}</span>
        <span className="shrink-0 text-[10px] text-zinc-400">{t('finances.pickLinkedTo', { id: linkedTo })}</span>
        <span className="shrink-0 text-sm font-medium text-zinc-400">{i.amount != null ? eur(i.amount) : '–'}</span>
      </div>
    ) : (
      <button key={`${i.source}:${i.id}`} type="button" onClick={onClick}
        className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition',
          selected ? 'border-emerald-500 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-950/30'
            : 'border-zinc-200 hover:border-emerald-400 hover:bg-emerald-50/50 dark:border-zinc-800 dark:hover:bg-emerald-950/20')}>
        <span className="w-12 shrink-0 text-xs text-zinc-400">{i.datum?.slice(8, 10)}.{i.datum?.slice(5, 7)}.</span>
        <span className="min-w-0 flex-1 truncate text-sm">{i.label}</span>
        <span className="shrink-0 text-sm font-medium">{i.amount != null ? eur(i.amount) : '–'}</span>
        {selected ? <CheckCircle2 size={16} className="shrink-0 text-emerald-500" /> : <Circle size={16} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
      </button>
    )
  );

  return (
    <Modal open onClose={onClose} title={`${t(isIncome ? 'finances.incomePickerTitle' : 'finances.pickerTitle')} · ${fix.label}`}>
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-8" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t('finances.pickerSearch')} />
        </div>
        {isLoading ? <Spinner /> : (
          <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto">
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t(isIncome ? 'finances.pickIncomeDoc' : 'finances.pickInvoice')}</div>
              {docs.length ? docs.map(i => evRow(i, docSel?.id === i.id, () => setDocSel(s => s?.id === i.id ? null : { id: i.id, amount: i.amount })))
                : <p className="px-1 py-1 text-xs text-zinc-400">{t(isIncome ? 'finances.incomePickerEmpty' : 'finances.pickerEmpty')}</p>}
            </div>
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.pickStatement')}</div>
              {banks.length ? banks.map(i => evRow(i, bankSel?.id === i.id, () => setBankSel(s => s?.id === i.id ? null : { id: i.id, amount: i.amount }), i.linked_einkauf_id))
                : <p className="px-1 py-1 text-xs text-zinc-400">{t('finances.pickNoStatements')}</p>}
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 pt-2.5 dark:border-zinc-800">
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={onClose}>{t('common.cancel')}</Button>
          <Button className="px-3 py-1.5 text-xs" disabled={!canLink} onClick={() => void doLink()}><Link2 size={14} className="mr-1 inline" />{t('finances.linkSelected')}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Create/edit a budget — either a category LIMIT (a goal on exactly one tree node) or a
 *  LENS (several categories and/or single articles, deliberately overlapping the tree).
 *  `kind` is immutable once stored, and a limit reached from a category row has its node
 *  fixed, so the switcher only appears when creating a free-standing budget. */
function BudgetModal({ initial, onClose, onSaved }: {
  initial: BudgetDraft; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { data: konten } = useKonten();
  const scopeKonten = useMemo(() => (konten ?? []).filter(k => !k.is_cash), [konten]);
  const [kind, setKind] = useState<'category' | 'lens'>(initial.kind);
  const [label, setLabel] = useState(initial.label ?? '');
  const [target, setTarget] = useState(initial.monthly_target != null ? String(initial.monthly_target).replace('.', ',') : '');
  const [kontoId, setKontoId] = useState(initial.konto_id ? String(initial.konto_id) : '');
  const [cats, setCats] = useState<string[]>(initial.categories ?? []);
  const [articles, setArticles] = useState<string[]>(initial.articles ?? []);
  const [artQ, setArtQ] = useState('');
  const lockKind = initial.lockKind || initial.id != null;

  // Article picker source: the canonical names actually bought (same list the search box
  // uses). No FK ties a lens to them, so a name that later disappears simply counts 0.
  const { data: names = [] } = useQuery({
    queryKey: ['names'],
    queryFn: () => api<{ canonical_name: string }[]>('/api/names'),
    enabled: kind === 'lens',
  });
  const artHits = useMemo(() => {
    const q = artQ.trim().toLowerCase();
    if (!q) return [];
    const seen = new Set(articles.map(a => a.toLowerCase()));
    const out: string[] = [];
    for (const n of names) {
      const nm = (n.canonical_name ?? '').trim();
      if (!nm || seen.has(nm.toLowerCase()) || !nm.toLowerCase().includes(q)) continue;
      seen.add(nm.toLowerCase());
      out.push(nm);
      if (out.length >= 12) break;
    }
    return out;
  }, [artQ, names, articles]);

  // A limit needs a goal; a lens may have none at all (pure observation → "kein Ziel").
  const targetOk = kind === 'lens' ? true : !!target.trim();
  const membersOk = kind === 'category' ? cats.length === 1 : (cats.length > 0 || articles.length > 0);
  const canSave = !!label.trim() && targetOk && membersOk;

  const save = useMutation({
    mutationFn: () => {
      const body = {
        kind,
        label: label.trim(),
        // Empty target is only meaningful for a lens; sent as null so the row renders
        // "kein Ziel" rather than a 0,00 goal it would instantly blow past.
        monthly_target: target.trim() ? target : null,
        konto_id: kontoId ? Number(kontoId) : null,
        categories: kind === 'category' ? cats.slice(0, 1) : cats,
        articles: kind === 'category' ? [] : articles,
      };
      return initial.id
        ? api(`/api/budgets/${initial.id}`, { method: 'PATCH', body })
        : api('/api/budgets', { method: 'POST', body });
    },
    onSuccess: () => { onSaved(); onClose(); },
    // The API — not the schema — enforces one limit per (category, konto): a UNIQUE index
    // could have failed on live data, so a duplicate answers 409 instead.
    onError: (e: Error) => toast(e.message === 'limit_exists' ? t('finances.limitExists') : e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/budgets/${initial.id}`, { method: 'DELETE' }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // Deleting a limit removes ONLY the goal — the category keeps its row and its spend.
  // That is the payoff of a derived tracker, so the dialog says it out loud.
  const askDelete = async () => {
    const ok = await confirm({
      title: t('common.delete'),
      message: t(kind === 'category' ? 'finances.deleteLimitConfirm' : 'finances.deleteLensConfirm', { label: label.trim() || initial.label }),
      confirmLabel: t('common.delete'), cancelLabel: t('common.cancel'), danger: true,
    });
    if (ok) remove.mutate();
  };

  const title = initial.id
    ? t(kind === 'category' ? 'finances.editLimit' : 'finances.editLens')
    : t(kind === 'category' ? 'finances.addLimitTitle' : 'finances.addLensTitle');

  return (
    <Modal open onClose={onClose} title={title}>
      <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (canSave) save.mutate(); }}>
        {!lockKind && (
          <div className="flex rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/60">
            {([['category', 'finances.kindCategory'], ['lens', 'finances.kindLens']] as const).map(([k, key]) => (
              <button key={k} type="button" onClick={() => setKind(k)}
                className={cn('flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  kind === k ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')}>
                {t(key)}
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-zinc-400">{t(kind === 'category' ? 'finances.kindCategoryHint' : 'finances.kindLensHint')}</p>
        <div>
          <Label>{t('finances.budgetLabel')}</Label>
          <Input autoFocus value={label} onChange={e => setLabel(e.target.value)} placeholder={t('finances.budgetLabelPlaceholder')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('finances.target')}</Label>
            <Input inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} placeholder={kind === 'lens' ? t('finances.noTarget') : '0,00'} />
            {kind === 'lens' && <p className="mt-1 text-[11px] text-zinc-400">{t('finances.targetOptional')}</p>}
          </div>
          <div>
            <Label>{t('finances.scope')}</Label>
            <Select value={kontoId} onChange={e => setKontoId(e.target.value)}>
              <option value="">{t('finances.wholeHousehold')}</option>
              {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
            </Select>
          </div>
        </div>
        <div>
          <Label>{t('finances.categoriesLabel')}</Label>
          {cats.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {cats.map(c => (
                <Badge key={c} className="inline-flex items-center gap-1">
                  {c.split('/').pop()}
                  <button type="button" onClick={() => setCats(cats.filter(x => x !== c))} className="text-zinc-400 hover:text-red-500" aria-label="×">
                    <X size={12} />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          {/* A limit is keyed to exactly ONE path (that is what makes it attachable to a
              tree node), so picking another replaces it. A lens keeps picks
              non-overlapping instead: a parent+child pair would double-count an article
              that falls under both, so a pick already covered by an ancestor is skipped
              and adding a parent drops the now-redundant descendants. */}
          <CategoryPicker value={kind === 'category' ? (cats[0] ?? null) : null} onChange={p => {
            if (!p) return;
            if (kind === 'category') { setCats([p]); return; }
            setCats(prev => prev.some(c => c === p || p.startsWith(c + '/')) ? prev : [...prev.filter(c => !c.startsWith(p + '/')), p]);
          }} />
          <p className="mt-1 text-xs text-zinc-400">{t('finances.categoriesHint')}</p>
        </div>
        {kind === 'lens' && (
          <div>
            <Label>{t('finances.articlesLabel')}</Label>
            {articles.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {articles.map(a => (
                  <Badge key={a} className="inline-flex items-center gap-1">
                    {a}
                    <button type="button" onClick={() => setArticles(articles.filter(x => x !== a))} className="text-zinc-400 hover:text-red-500" aria-label="×">
                      <X size={12} />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <Input value={artQ} onChange={e => setArtQ(e.target.value)} placeholder={t('finances.articleSearch')} />
            {artHits.length > 0 && (
              <div className="mt-1 flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800">
                {artHits.map(a => (
                  <button key={a} type="button" onClick={() => { setArticles(prev => [...prev, a]); setArtQ(''); }}
                    className="px-3 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800">
                    {a}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-zinc-400">{t('finances.articlesHint')}</p>
          </div>
        )}
        <div className="mt-1 flex items-center justify-between gap-2">
          {initial.id
            ? <Button type="button" variant="ghost" className="text-red-500" onClick={() => void askDelete()}><Trash2 size={14} /> {t('common.delete')}</Button>
            : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!canSave || save.isPending}>{t('common.save')}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ── management tab (fixed-cost master data) ─────────────────────────────────

/** Umbuchung pairing control: link this transfer leg to its opposite leg — pick
 *  an existing fixed cost or create the counterpart on another account. Only
 *  shown for a saved transfer; a brand-new row must be saved before it can pair
 *  (the backend needs its id to write the symmetric link). */
function CounterpartField({ draft, setDraft, costs, scopeKonten }: {
  draft: Draft; setDraft: (d: Draft) => void; costs: FixedCost[]; scopeKonten: KontoLite[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [cpLabel, setCpLabel] = useState('');
  const [cpKonto, setCpKonto] = useState('');

  const partner = draft.counterpart_id != null ? costs.find(c => c.id === draft.counterpart_id) : null;
  // The natural counterpart is an opposite-kind transfer on *another* account.
  const candidates = costs.filter(c => c.is_transfer && c.id !== draft.id && c.kind !== draft.kind && String(c.konto_id) !== draft.konto_id);

  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/api/fixed-costs', { method: 'POST', body: {
      label: cpLabel.trim(),
      monthly_eur: draft.monthly_eur,
      kind: draft.kind === 'income' ? 'expense' : 'income',
      frequency: draft.frequency,
      is_transfer: true,
      konto_id: Number(cpKonto),
      category_path: draft.category_path,
      start_date: draft.start_date,
      end_date: draft.end_date || null,
      active: draft.active,
      expect_receipt: false,
      counterpart_id: draft.id,
    } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['fixed-costs'] });
      setDraft({ ...draft, counterpart_id: r.id });
      setCreating(false); setCpLabel(''); setCpKonto('');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // Matching bank bookings on another account (opposite sign, same amount) that can
  // BE the counterpart — picking one auto-creates its Fixkosten leg + links + pairs.
  const { data: bankCands } = useQuery({
    queryKey: ['cp-bank', draft.id],
    queryFn: () => api<{ candidates: { id: number; konto_id: number; konto_name: string | null; datum: string; amount: number; counterparty: string | null }[] }>(`/api/finances/fixed-cost/${draft.id}/bank-counterpart-candidates`),
    enabled: !!draft.id,
  });
  const pairFromBank = useMutation({
    mutationFn: (bankTxId: number) => api<{ counterpart_id: number }>(`/api/finances/fixed-cost/${draft.id}/counterpart-from-bank`, { method: 'POST', body: { bank_tx_id: bankTxId } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['fixed-costs'] });
      void qc.invalidateQueries({ queryKey: ['bank-tx'] });
      void qc.invalidateQueries({ queryKey: ['fin-month'] });
      setDraft({ ...draft, counterpart_id: r.counterpart_id });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (!draft.id) return <p className="pl-11 text-xs text-zinc-400">{t('finances.cpSaveFirst')}</p>;

  return (
    <div className="ml-11 rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900/50 dark:bg-violet-950/20">
      <Label>{t('finances.counterpart')}</Label>
      {partner ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="min-w-0 truncate">↔ <span className="font-medium">{partner.label}</span> <span className="text-zinc-500">· {partner.konto_name}</span></span>
          <button type="button" onClick={() => setDraft({ ...draft, counterpart_id: null })}
            className="shrink-0 text-xs text-red-500 hover:underline">{t('finances.unlink')}</button>
        </div>
      ) : creating ? (
        <div className="flex flex-col gap-2">
          <Input value={cpLabel} onChange={e => setCpLabel(e.target.value)} placeholder={t('finances.label')} />
          <Select value={cpKonto} onChange={e => setCpKonto(e.target.value)}>
            <option value="" disabled>–</option>
            {scopeKonten.filter(k => String(k.id) !== draft.konto_id).map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
          </Select>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setCreating(false); setCpLabel(''); setCpKonto(''); }}
              className="text-xs text-zinc-500 hover:underline">{t('common.cancel')}</button>
            <button type="button" disabled={!cpLabel.trim() || !cpKonto || create.isPending} onClick={() => create.mutate()}
              className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">{t('finances.cpCreate')}</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Select value="" onChange={e => e.target.value && setDraft({ ...draft, counterpart_id: Number(e.target.value) })}>
            <option value="">{t('finances.cpPick')}</option>
            {candidates.map(c => <option key={c.id} value={c.id}>{c.label} · {c.konto_name}</option>)}
          </Select>
          {(bankCands?.candidates.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.cpBankCandidates')}</div>
              {bankCands!.candidates.map(b => (
                <button key={b.id} type="button" disabled={pairFromBank.isPending} onClick={() => pairFromBank.mutate(b.id)}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2 py-1.5 text-left text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50">
                  <Landmark size={12} className="shrink-0 text-sky-500" />
                  <span className="min-w-0 flex-1 truncate">{b.counterparty || '—'} <span className="text-zinc-400">· {b.konto_name}</span></span>
                  <span className="shrink-0 tabular-nums">{eur(b.amount)}</span>
                  <span className="shrink-0 text-zinc-400">{ddmmyyyy(b.datum)}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => { setCreating(true); setCpLabel(draft.label); }}
            className="self-start text-xs text-violet-600 hover:underline dark:text-violet-400">+ {t('finances.cpCreate')}</button>
        </div>
      )}
      <p className="mt-2 text-xs text-zinc-400">{t('finances.counterpartHint')}</p>
    </div>
  );
}

type Draft = { id?: number; label: string; monthly_eur: string; kind: 'expense' | 'income'; frequency: Freq; is_transfer: boolean; konto_id: string; category_path: string | null; start_date: string; end_date: string; active: boolean; expect_receipt: boolean; match_merchant: string; counterpart_id: number | null };
const emptyDraft = (kontoId?: number, kind: 'expense' | 'income' = 'expense'): Draft => ({
  label: '', monthly_eur: '', kind, frequency: 'monthly', is_transfer: false, konto_id: kontoId ? String(kontoId) : '', category_path: null,
  start_date: today(), end_date: '', active: true, expect_receipt: true, match_merchant: '', counterpart_id: null,
});
const draftFromCost = (c: FixedCost): Draft => ({
  id: c.id, label: c.label, monthly_eur: String(c.monthly_eur).replace('.', ','), kind: c.kind, frequency: c.frequency,
  is_transfer: c.is_transfer, konto_id: String(c.konto_id ?? ''), category_path: c.category_path, start_date: c.start_date,
  end_date: c.end_date ?? '', active: c.active, expect_receipt: c.expect_receipt, match_merchant: c.match_merchant ?? '', counterpart_id: c.counterpart_id,
});

/** Upload one or more pay slips (DATEV etc.) → each is OCR'd and filed as an
 *  income row for the chosen account. Files upload sequentially with a per-file
 *  result line. Bank-statement CSV import is a separate (upcoming) evidence path. */
function PayslipUpload({ scopeKonten, embedded }: { scopeKonten: KontoLite[]; embedded?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [kontoId, setKontoId] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; text: string }[]>([]);

  // Default to the first personal (non-shared) account — a salary belongs to a person.
  const defaultKonto = useMemo(() => {
    const personal = scopeKonten.find(k => !k.is_shared);
    return String((personal ?? scopeKonten[0])?.id ?? '');
  }, [scopeKonten]);
  const effKonto = kontoId || defaultKonto;

  const readB64 = (file: File) => new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(file);
  });

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    if (!effKonto) { toast(t('finances.income.pickAccount'), 'error'); return; }
    setBusy(true);
    const out: { name: string; ok: boolean; text: string }[] = [];
    for (const file of Array.from(list)) {
      try {
        const b64 = await readB64(file);
        const r = await api<{ ok: boolean; netto?: number; monat?: string; arbeitgeber?: string | null; reason?: string }>(
          '/api/finances/income/upload', { method: 'POST', body: { filename: file.name, data_b64: b64, konto_id: Number(effKonto) } });
        out.push(r.ok
          ? { name: file.name, ok: true, text: `${eur(r.netto!)} · ${r.monat ?? '?'}${r.arbeitgeber ? ' · ' + r.arbeitgeber : ''}` }
          : { name: file.name, ok: false, text: r.reason ?? t('finances.income.unreadable') });
      } catch (e) {
        out.push({ name: file.name, ok: false, text: (e as Error).message });
      }
      setResults([...out]);
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ['fin-month'] });
    void qc.invalidateQueries({ queryKey: ['fin-income'] });
    const n = out.filter(o => o.ok).length;
    if (n) toast(t('finances.income.importedToast', { n }), 'success');
  }

  const body = (
    <>
      {!embedded && (
        <div className="flex items-center gap-2">
          <Upload size={16} className="text-emerald-600 dark:text-emerald-500" />
          <h2 className="text-base font-semibold">{t('finances.income.heading')}</h2>
        </div>
      )}
      <p className="text-xs text-zinc-500">{t('finances.income.intro')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[9rem] flex-1">
          <Label>{t('finances.income.account')}</Label>
          <Select value={effKonto} onChange={e => setKontoId(e.target.value)}>
            {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
          </Select>
        </div>
        <label className={cn(
          'inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700',
          busy && 'pointer-events-none opacity-50',
        )}>
          <Upload size={15} />
          {busy ? t('finances.income.working') : t('finances.income.choose')}
          <input type="file" accept="application/pdf,image/*" multiple className="hidden" disabled={busy}
            onChange={e => { void onFiles(e.target.files); e.target.value = ''; }} />
        </label>
      </div>
      {results.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          {results.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              {r.ok
                ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" />
                : <X size={14} className="mt-0.5 shrink-0 text-red-500" />}
              <span className="min-w-0 flex-1"><span className="text-zinc-400">{r.name}</span> — {r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
  return embedded ? <div className="flex flex-col gap-3">{body}</div> : <Card className="flex flex-col gap-3 p-4">{body}</Card>;
}

// ── Erfasste Einnahmen (actual income rows: pay slips / CSV credits) ──────────
interface IncomeEntry {
  id: number; datum: string; amount: number; source: string; description: string | null;
  konto_id: number | null; konto_name: string | null; is_shared: boolean | null;
  owner: string | null; owner_name: string | null;
  has_file?: boolean; file_name?: string | null;
  bank: { id: number; booking_date: string; amount: number; counterparty: string | null } | null;
}

/** View a stored pay-slip file. Fetched with the auth header (the file endpoint is
 *  auth-guarded, so a plain <img>/<iframe> src wouldn't carry the token) into a blob
 *  object URL, shown inline; PDFs in an iframe, images as <img>. */
function PayslipViewer({ id, name, t, onClose }: {
  id: number; name: string; t: (k: string, o?: Record<string, unknown>) => string; onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [isPdf, setIsPdf] = useState(true);
  const [err, setErr] = useState(false);
  // Mobile browsers (esp. iOS Safari) render a PDF inside an <iframe> as a blank box.
  // On touch/coarse-pointer devices offer open/download instead of the dead preview.
  const [coarse] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const token = getToken();
        const res = await fetch(`/api/finances/income/${id}/file`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) { setUrl(objectUrl); setIsPdf(blob.type === 'application/pdf'); }
      } catch { if (!cancelled) setErr(true); }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return (
    <Modal open onClose={onClose} title={name || t('finances.income.viewPayslip')} wide>
      <div className="flex flex-col gap-2">
        {err ? <p className="py-10 text-center text-sm text-zinc-400">{t('finances.income.viewError')}</p>
          : !url ? <div className="flex justify-center py-16"><Spinner /></div>
            : !isPdf ? <img src={url} alt={name} className="mx-auto max-h-[72vh] rounded-lg" />
              : coarse ? (
                // Touch device: an embedded PDF stays blank, so present it as actions.
                <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
                  <FileText size={44} className="text-emerald-500" />
                  <div className="text-sm font-medium">{name || t('finances.income.viewPayslip')}</div>
                  <div className="flex flex-wrap justify-center gap-2">
                    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                      <ExternalLink size={15} /> {t('finances.income.openPdf')}
                    </a>
                    <a href={url} download={name || 'gehaltszettel.pdf'} className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                      <FileText size={15} /> {t('finances.income.downloadPdf')}
                    </a>
                  </div>
                </div>
              )
                : <iframe src={url} title={name} className="h-[72vh] w-full rounded-lg border border-zinc-200 dark:border-zinc-800" />}
        {url && !coarse && <a href={url} target="_blank" rel="noreferrer" className="self-end text-xs text-emerald-600 hover:underline dark:text-emerald-400">{t('finances.income.openTab')}</a>}
      </div>
    </Modal>
  );
}

function IncomeList({ onUpload }: { onUpload: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [viewFile, setViewFile] = useState<{ id: number; name: string } | null>(null);
  const [year, setYear] = useState(String(new Date().getFullYear())); // default: current year
  const [member, setMember] = useState(''); // '' = all members
  const { data, isLoading } = useQuery({
    queryKey: ['fin-income'],
    queryFn: () => api<{ income: IncomeEntry[] }>('/api/finances/income'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/finances/income/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fin-income'] });
      void qc.invalidateQueries({ queryKey: ['fin-month'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const attach = useMutation({
    mutationFn: async ({ id, file }: { id: number; file: File }) => {
      const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('read failed')); r.readAsDataURL(file); });
      return api(`/api/finances/income/${id}/file`, { method: 'POST', body: { filename: file.name, data_b64: b64 } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fin-income'] }); toast(t('finances.income.attached'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const srcLabel = (s: string) => t(`finances.income.src.${s}`, { defaultValue: s });

  // Member = owner (personal) or the account (shared) the income was booked to. The
  // dropdown only lists members who actually have recorded income (data-driven, never
  // hardcoded to a specific household). Year comes straight off each entry's date.
  const allRows = data?.income ?? [];
  const memberKey = (r: { owner: string | null; konto_id: number | null }) => r.owner ?? (r.konto_id != null ? `k${r.konto_id}` : '');
  const years = useMemo(() => {
    const s = new Set<string>([String(new Date().getFullYear())]);
    for (const r of allRows) s.add(r.datum.slice(0, 4));
    return [...s].sort((a, b) => b.localeCompare(a));
  }, [allRows]);
  const members = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of allRows) { const k = memberKey(r); if (k) m.set(k, scopeLabelOf(t, r)); }
    return [...m.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [allRows, t]);
  const rows = useMemo(() => allRows.filter(r =>
    (!year || r.datum.slice(0, 4) === year) && (!member || memberKey(r) === member),
  ), [allRows, year, member]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  // If the selected filter value disappears from the data (e.g. the last income for that
  // member/year was deleted), fall back to "all" so the dropdown and the list can't desync.
  useEffect(() => { if (member && !members.some(m => m.key === member)) setMember(''); }, [members, member]);
  useEffect(() => { if (year && !years.includes(year)) setYear(''); }, [years, year]);

  return (
    <>
      <CollapseCard
        icon={<Wallet size={17} className="text-emerald-600 dark:text-emerald-500" />}
        title={t('finances.income.listHeading')}
        right={<span className="text-sm font-medium text-emerald-600 dark:text-emerald-500">+{eur(total)}</span>}
        onAdd={onUpload}
        addTitle={t('finances.income.heading')}
      >
      <div className="flex gap-2">
        <Select value={year} onChange={e => setYear(e.target.value)}>
          <option value="">{t('finances.income.allYears')}</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </Select>
        <Select value={member} onChange={e => setMember(e.target.value)}>
          <option value="">{t('finances.income.allMembers')}</option>
          {members.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </Select>
      </div>
      {isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-xs text-zinc-400">{t('finances.income.listEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map(r => (
            <li key={r.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.description || t('finances.income.entryFallback')}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{ddmmyyyy(r.datum)}</span>
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">{srcLabel(r.source)}</span>
                  {r.konto_id && <span className="truncate">{scopeLabelOf(t, r)}</span>}
                  {r.bank && (
                    <Link to={`/finanzen?tab=bank&bm=${r.bank.booking_date.slice(0, 7)}&bhl=${r.bank.id}`} onClick={e => e.stopPropagation()}
                      className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] text-teal-700 hover:bg-teal-200 dark:bg-teal-900/40 dark:text-teal-300">
                      <Landmark size={10} /> {t('finances.bank.matched')}
                    </Link>
                  )}
                </div>
              </div>
              <span className="shrink-0 text-sm font-semibold text-emerald-600 dark:text-emerald-500">+{eur(r.amount)}</span>
              {r.has_file ? (
                <button
                  onClick={() => setViewFile({ id: r.id, name: r.file_name ?? '' })}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"
                  title={t('finances.income.view')}
                >
                  <FileText size={15} />
                </button>
              ) : (
                <label className="shrink-0 cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800" title={t('finances.income.attach')}>
                  <Paperclip size={15} />
                  <input type="file" accept=".pdf,image/*" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) attach.mutate({ id: r.id, file: f }); e.target.value = ''; }} />
                </label>
              )}
              <button
                onClick={() => remove.mutate(r.id)}
                className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
                title={t('common.delete')}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      </CollapseCard>
      {viewFile && <PayslipViewer id={viewFile.id} name={viewFile.name} t={t} onClose={() => setViewFile(null)} />}
    </>
  );
}

// ── Kontobewegungen (bank CSV import + matched-status list) ──────────────────
interface BankTx {
  id: number; konto_id: number | null; konto_name: string | null;
  booking_date: string; purchase_date: string | null; amount: number;
  counterparty: string | null; description: string | null; private: boolean;
  review_flag: boolean;
  status: 'open' | 'fixed' | 'receipt' | 'income';
  receipt: { id: number | null; laden: string | null; betrag: number | null; private: boolean } | null;
  income: { id: number; description: string | null; betrag: number } | null;
  fixed: { id: number; label: string; kind: 'expense' | 'income'; expect_receipt: boolean; month: string } | null;
  suggestion: { kind: 'receipt' | 'income' | 'fixed'; target_id: number; label: string | null; confidence: number; reason: string | null; private: boolean } | null;
}

/** Upload one or more comdirect "Umsätze Girokonto" CSVs into a chosen account.
 *  One CSV = one account (picked here). Re-import is idempotent (dedup by Ref.). */
function BankUpload({ scopeKonten, embedded }: { scopeKonten: KontoLite[]; embedded?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [kontoId, setKontoId] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; text: string }[]>([]);
  // A new (unrecognized) bank format → the AI-generated mapping awaits the user's one-time confirm.
  type PreviewRow = { booking_date: string; amount: number; counterparty: string | null; description: string };
  const [confirm, setConfirm] = useState<null | { file: string; b64: string; konto: number; spec: unknown; fingerprint: string; preview: PreviewRow[]; total: number; label: string }>(null);
  const eff = kontoId || String(scopeKonten[0]?.id ?? '');
  const readB64 = (file: File) => new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(file);
  });
  interface AnalyzeResult { recognized: boolean; source?: string; label?: string | null; spec?: unknown; fingerprint?: string; preview: PreviewRow[]; total: number; error?: string }
  const refreshBank = () => { void qc.invalidateQueries({ queryKey: ['bank-tx'] }); void qc.invalidateQueries({ queryKey: ['bank-batches'] }); void qc.invalidateQueries({ queryKey: ['fin-month'] }); };
  const doImport = (p: { file: string; b64: string; konto: number; spec?: unknown; save?: boolean; fingerprint?: string; label?: string }) =>
    api<{ ok: boolean; imported?: number; skipped?: number; reason?: string }>('/api/finances/bank/upload', { method: 'POST',
      body: { filename: p.file, data_b64: p.b64, konto_id: p.konto, spec: p.spec, save_mapping: p.save, fingerprint: p.fingerprint, label: p.label } });

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    if (!eff) { toast(t('finances.bank.pickAccount'), 'error'); return; }
    setBusy(true);
    const out: { name: string; ok: boolean; text: string }[] = [];
    for (const file of Array.from(list)) {
      try {
        const b64 = await readB64(file);
        // Detect the format first — no import yet.
        const a = await api<AnalyzeResult>('/api/finances/bank/analyze', { method: 'POST', body: { data_b64: b64 } });
        if (a.recognized) {
          const r = await doImport({ file: file.name, b64, konto: Number(eff), spec: a.spec ?? undefined });
          out.push(r.ok
            ? { name: file.name, ok: true, text: t('finances.bank.importedResult', { imported: r.imported, skipped: r.skipped }) + (a.label ? ` · ${a.label}` : '') }
            : { name: file.name, ok: false, text: r.reason ?? t('finances.bank.unreadable') });
          setResults([...out]);
        } else if (a.spec) {
          // New format — pause and let the user verify the AI mapping once (handles one at a time).
          setConfirm({ file: file.name, b64, konto: Number(eff), spec: a.spec, fingerprint: a.fingerprint ?? '', preview: a.preview ?? [], total: a.total ?? 0, label: '' });
          setBusy(false);
          return;
        } else {
          out.push({ name: file.name, ok: false, text: a.error ?? t('finances.bank.unreadable') });
          setResults([...out]);
        }
      } catch (e) { out.push({ name: file.name, ok: false, text: (e as Error).message }); setResults([...out]); }
    }
    setBusy(false);
    refreshBank();
    const n = out.filter(o => o.ok).length;
    if (n) toast(t('finances.bank.importedToast', { n }), 'success');
  }

  async function confirmImport() {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await doImport({ file: confirm.file, b64: confirm.b64, konto: confirm.konto, spec: confirm.spec, save: true, fingerprint: confirm.fingerprint, label: confirm.label.trim() || undefined });
      setResults(rs => [...rs, r.ok
        ? { name: confirm.file, ok: true, text: t('finances.bank.importedResult', { imported: r.imported, skipped: r.skipped }) }
        : { name: confirm.file, ok: false, text: r.reason ?? t('finances.bank.unreadable') }]);
      if (r.ok) toast(t('finances.bank.importedToast', { n: 1 }), 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    setBusy(false); setConfirm(null); refreshBank();
  }
  const body = (
    <>
      {!embedded && (
        <div className="flex items-center gap-2">
          <Upload size={16} className="text-emerald-600 dark:text-emerald-500" />
          <h2 className="text-base font-semibold">{t('finances.bank.heading')}</h2>
        </div>
      )}
      <p className="text-xs text-zinc-500">{t('finances.bank.intro')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[9rem] flex-1">
          <Label>{t('finances.bank.account')}</Label>
          <Select value={eff} onChange={e => setKontoId(e.target.value)}>
            {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
          </Select>
        </div>
        <label className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700', busy && 'pointer-events-none opacity-50')}>
          <Upload size={15} />
          {busy ? t('finances.bank.working') : t('finances.bank.choose')}
          <input type="file" accept=".csv,text/csv,text/plain" multiple className="hidden" disabled={busy}
            onChange={e => { void onFiles(e.target.files); e.target.value = ''; }} />
        </label>
      </div>
      {results.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          {results.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              {r.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" /> : <X size={14} className="mt-0.5 shrink-0 text-red-500" />}
              <span className="min-w-0 flex-1"><span className="text-zinc-400">{r.name}</span> — {r.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-zinc-400">{t('finances.bank.hint')}</p>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => !busy && setConfirm(null)}>
          <div className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}>
            {/* A mis-mapped AI column guess is THE thing to report from here, but this
                overlay covers the header icon, the demo pill and — when BankUpload is
                embedded in a Modal — that modal's feedback icon too. */}
            <div className="mb-1 flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2 text-base font-bold"><Sparkles size={18} className="shrink-0 text-emerald-600" /> {t('finances.bank.aiTitle')}</div>
              <FeedbackIconButton />
            </div>
            <p className="mb-3 text-xs text-zinc-500">{t('finances.bank.aiHint', { total: confirm.total })}</p>
            <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-800/60">
                  <tr><th className="px-2 py-1.5">{t('finances.bank.colDate')}</th><th className="px-2 py-1.5 text-right">{t('finances.bank.colAmount')}</th><th className="px-2 py-1.5">{t('finances.bank.colCounterparty')}</th></tr>
                </thead>
                <tbody>
                  {confirm.preview.map((r, i) => (
                    <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="whitespace-nowrap px-2 py-1 tabular-nums">{r.booking_date}</td>
                      <td className={cn('whitespace-nowrap px-2 py-1 text-right tabular-nums', r.amount < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>{eur(r.amount)}</td>
                      <td className="px-2 py-1"><span className="line-clamp-1">{r.counterparty || r.description || '—'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3">
              <Label>{t('finances.bank.aiLabel')}</Label>
              <Input value={confirm.label} onChange={e => setConfirm(c => c && { ...c, label: e.target.value })} placeholder={t('finances.bank.aiLabelPh')} />
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
              <Button disabled={busy} onClick={() => void confirmImport()}>{busy ? '…' : t('finances.bank.aiConfirm')}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
  return embedded ? <div className="flex flex-col gap-3">{body}</div> : <Card className="flex flex-col gap-3 p-4">{body}</Card>;
}

function BankRow({ tx, t, highlight, onOpen, onOpenFixed, onLink, onUnlink, onFlag, onGenerate, onApprove, onDismiss }: {
  tx: BankTx; t: (k: string, o?: Record<string, unknown>) => string; highlight?: boolean;
  onOpen: (receiptId: number) => void; onOpenFixed: (tx: BankTx) => void; onLink: (tx: BankTx) => void; onUnlink: (id: number) => void;
  onFlag: (id: number, flag: boolean) => void; onGenerate: (tx: BankTx) => void;
  onApprove: (id: number) => void; onDismiss: (id: number) => void;
}) {
  useEffect(() => { if (highlight) document.getElementById(`bank-row-${tx.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [highlight, tx.id]);
  const credit = tx.amount > 0;
  const canOpen = tx.status === 'receipt' && tx.receipt?.id != null && !tx.receipt.private;
  // A booking used as evidence for a fixed cost / one-off income (e.g. a generated
  // "…Spesen" income) → jump to that plan's month so the user reaches the generated entry.
  const canOpenFixed = tx.status === 'fixed' && tx.fixed != null;
  const canLink = tx.status === 'open'; // debit → receipt, credit → income row
  const isLinked = tx.status === 'receipt' || tx.status === 'income';
  const badge = tx.status === 'receipt' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
    : tx.status === 'income' ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'
      : tx.status === 'fixed' ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  const onClick = canOpen ? () => onOpen(tx.receipt!.id!) : canOpenFixed ? () => onOpenFixed(tx) : canLink ? () => onLink(tx) : undefined;
  // Long-press (touch or mouse-hold, ~500 ms) toggles the shared red review mark.
  // A fired long-press suppresses the click that follows it.
  const longPressed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPress = () => {
    longPressed.current = false;
    timer.current = setTimeout(() => { longPressed.current = true; onFlag(tx.id, !tx.review_flag); }, 500);
  };
  const cancelPress = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const handleClick = () => { if (longPressed.current) { longPressed.current = false; return; } onClick?.(); };
  useEffect(() => cancelPress, []); // clear a pending long-press timer if the row unmounts mid-hold
  // Inner action buttons swallow the pointer so a hold on them never arms the long-press.
  const stopArm = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <Card
      id={`bank-row-${tx.id}`}
      onClick={handleClick}
      onPointerDown={startPress} onPointerUp={cancelPress} onPointerLeave={cancelPress} onPointerCancel={cancelPress}
      className={cn('flex select-none items-center gap-3 p-3',
        tx.review_flag && 'ring-2 ring-red-400 dark:ring-red-500/70',
        highlight && 'bg-amber-100 ring-2 ring-amber-400 dark:bg-amber-900/30 dark:ring-amber-500/70')}
    >
      {tx.review_flag && <Flag size={14} className="shrink-0 fill-red-500 text-red-500" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {tx.private
            ? <span className="inline-flex items-center gap-1 italic text-zinc-500 dark:text-zinc-400"><Lock size={12} />{t('finances.privatePurchase')}</span>
            : (tx.counterparty || '—')}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{ddmmyyyy(tx.booking_date)}</span>
          {tx.konto_name && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{tx.konto_name}</span>}
          <span className={cn('rounded-full px-1.5 py-0.5 text-[10px]', badge)}>{t(`finances.bank.status_${tx.status}`)}</span>
          {tx.status === 'receipt' && tx.receipt && !tx.receipt.private && tx.receipt.laden && <span className="truncate">→ {tx.receipt.laden}</span>}
          {tx.status === 'income' && tx.income && <span className="truncate">→ {tx.income.description || t('finances.income.entryFallback')}</span>}
          {tx.status === 'fixed' && tx.fixed && <span className="truncate">→ {tx.fixed.label}</span>}
          {canLink && !tx.suggestion && <span className="text-zinc-400">{credit ? t('finances.bank.tapToLinkIncome') : t('finances.bank.tapToLink')}</span>}
          {tx.suggestion && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" title={tx.suggestion.reason ?? undefined}>
              <Sparkles size={11} className="shrink-0 text-amber-500" /> {t('finances.bank.aiSuggests')} <span className="max-w-[10rem] truncate">{tx.suggestion.private ? t('finances.privatePurchase') : (tx.suggestion.label || '—')}</span> · {Math.round(tx.suggestion.confidence * 100)}%
            </span>
          )}
        </div>
      </div>
      <span className={cn('shrink-0 text-sm font-semibold', credit && 'text-emerald-600 dark:text-emerald-500')}>{credit ? '+' : ''}{eur(tx.amount)}</span>
      {tx.suggestion ? (
        <>
          <button onClick={e => { e.stopPropagation(); onApprove(tx.id); }} onPointerDown={stopArm} title={t('finances.bank.approveSuggestion')}
            className="shrink-0 rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"><CheckCircle2 size={16} /></button>
          <button onClick={e => { e.stopPropagation(); onDismiss(tx.id); }} onPointerDown={stopArm} title={t('finances.bank.dismissSuggestion')}
            className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><X size={16} /></button>
        </>
      ) : (
        <>
          {isLinked && !tx.receipt?.private && (
            <button onClick={e => { e.stopPropagation(); onUnlink(tx.id); }} onPointerDown={stopArm} title={t('finances.bank.unlink')}
              className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-500 dark:hover:bg-zinc-800"><Link2Off size={15} /></button>
          )}
          {canLink && (
            <button onClick={e => { e.stopPropagation(); onGenerate(tx); }} onPointerDown={stopArm} title={t('finances.bank.gen.button')}
              className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30"><FilePlus2 size={15} /></button>
          )}
          {canLink && <Link2 size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
          {canOpen && <ChevronRight size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
        </>
      )}
    </Card>
  );
}

/** Pick a receipt (debit) or income row (credit) to link to a bank transaction.
 *  Candidates come pre-filtered by amount + date window from the backend. */
function BankLinkPicker({ tx, t, onClose, onPick, onApprove }: {
  tx: BankTx; t: (k: string, o?: Record<string, unknown>) => string; onClose: () => void; onPick: (id: number) => void; onApprove: (id: number) => void;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['bank-candidates', tx.id],
    queryFn: () => api<{ kind: 'receipt' | 'income'; candidates: { id: number; label: string | null; betrag: number; datum: string }[] }>(`/api/finances/bank/${tx.id}/candidates`),
  });
  const cands = data?.candidates ?? [];
  const sug = tx.suggestion;
  // Free-text search across ALL still-unlinked receipts (merchant / item / amount /
  // date), so the user can allocate one they know is right even when it falls outside
  // the automatic amount+date window (e.g. an Amazon part-shipment).
  const [q, setQ] = useState('');
  const searching = q.trim().length >= 1;
  const searchQ = useQuery({
    queryKey: ['bank-search', tx.id, q.trim()],
    queryFn: () => api<{ kind: 'receipt' | 'income'; results: { id: number; label: string | null; betrag: number; datum: string }[] }>(`/api/finances/bank/${tx.id}/search-receipts?q=${encodeURIComponent(q.trim())}`),
    enabled: searching,
  });
  const results = searchQ.data?.results ?? [];
  // Credit → book it as a REFUND on an existing receipt (negative position) instead of income.
  const qc = useQueryClient();
  const [refundMode, setRefundMode] = useState(false);
  const refundCands = useQuery({
    queryKey: ['bank-refund-cands', tx.id],
    queryFn: () => api<{ candidates: RefundCandidate[] }>(`/api/finances/bank/${tx.id}/refund-candidates`),
    enabled: refundMode,
  });
  const refundMut = useMutation({
    mutationFn: (p: RefundBookPayload) => api(`/api/finances/bank/${tx.id}/refund`, { method: 'POST', body: p }),
    onSuccess: () => {
      toast(t('profile.mailbox.log.refundBooked'), 'success');
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  // Debit → receipt candidates: offer a "view" (new tab) so the user can inspect the
  // receipt before linking (e.g. tell apart several Amazon orders found by item name).
  const isDebit = tx.amount < 0;
  // Full CSV booking text (Auftraggeber / Buchungstext / order number / Ref.) so the
  // user can judge what an unclear booking is actually about before allocating it.
  const [showText, setShowText] = useState(false);
  const row = (c: { id: number; label: string | null; betrag: number; datum: string }) => (
    <li key={c.id} className="flex items-center gap-1">
      <button onClick={() => onPick(c.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{c.label || '–'}</div>
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{ddmmyyyy(c.datum)}</div>
        </div>
        <span className="shrink-0 text-sm font-semibold">{eur(c.betrag)}</span>
      </button>
      {isDebit && (
        <a href={`/receipts/${c.id}`} target="_blank" rel="noreferrer" title={t('finances.bank.viewReceipt')}
          className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"><ExternalLink size={15} /></a>
      )}
    </li>
  );
  if (refundMode) {
    if (refundCands.isLoading) {
      return <Modal open onClose={() => setRefundMode(false)} title={t('finances.bank.linkIncomeTitle')}><div className="py-8 text-center"><Spinner /></div></Modal>;
    }
    return (
      <RefundReconcileDialog
        amount={Math.abs(tx.amount)}
        merchant={tx.counterparty}
        candidates={refundCands.data?.candidates ?? []}
        booking={refundMut.isPending}
        onClose={() => setRefundMode(false)}
        onBook={(p) => refundMut.mutate(p)}
      />
    );
  }
  return (
    <Modal open onClose={onClose} title={tx.amount > 0 ? t('finances.bank.linkIncomeTitle') : t('finances.bank.linkTitle')}>
      <div className="flex flex-col gap-3">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{tx.counterparty} · {eur(tx.amount)} · {ddmmyyyy(tx.booking_date)}</div>
        {tx.amount > 0 && (
          <button type="button" onClick={() => setRefundMode(true)}
            className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-amber-300 px-3 py-2 text-sm font-medium text-amber-600 hover:border-amber-400 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/30">
            <Undo2 size={15} /> {t('finances.bank.bookRefund')}
          </button>
        )}
        {/* Full CSV booking text — reveal to judge what an unclear booking is about. */}
        {!tx.private && tx.description && (
          <div>
            <button type="button" onClick={() => setShowText(v => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400">
              <FileText size={13} /> {showText ? t('finances.bank.hideText') : t('finances.bank.showText')}
            </button>
            {showText && <div className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-2 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">{tx.description}</div>}
          </div>
        )}
        {/* The AI proposal (⭐), distinct from the deterministic matches. Full reason
            shown (not truncated); jump to inspect the proposed receipt, then approve. */}
        {sug && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
            <div className="flex items-start gap-2">
              <Sparkles size={16} className="mt-0.5 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{sug.private ? t('finances.privatePurchase') : (sug.label || '—')}</div>
                <div className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">{t('finances.bank.aiSuggests')} {Math.round(sug.confidence * 100)}%</div>
                {sug.reason && !sug.private && <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{sug.reason}</div>}
              </div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-3">
              {sug.kind === 'receipt' && sug.target_id != null && !sug.private && (
                <button type="button" onClick={() => { onClose(); navigate(`/receipts/${sug.target_id}`); }}
                  className="inline-flex items-center gap-0.5 text-xs font-medium text-amber-700 hover:underline dark:text-amber-300">
                  {t('finances.bank.viewProposed')} <ChevronRight size={13} />
                </button>
              )}
              <button type="button" onClick={() => { onApprove(tx.id); onClose(); }}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700">
                <CheckCircle2 size={14} /> {t('finances.bank.approveSuggestion')}
              </button>
            </div>
          </div>
        )}
        {/* Manual search: allocate any unlinked receipt/income the user knows is right. */}
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-9 pr-9" placeholder={t(tx.amount > 0 ? 'finances.bank.searchIncomePlaceholder' : 'finances.bank.searchReceiptPlaceholder')} value={q} onChange={e => setQ(e.target.value)} />
          {q && (
            <button onClick={() => setQ('')} title={t('common.clear')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
              <X size={15} />
            </button>
          )}
        </div>
        {searching ? (
          searchQ.isLoading ? <Spinner /> : !results.length ? (
            <p className="py-4 text-center text-xs text-zinc-400">{t('finances.bank.noSearchResults')}</p>
          ) : (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.bank.searchResults')}</div>
              <ul className="-mx-1 flex max-h-[55vh] flex-col divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">{results.map(row)}</ul>
            </>
          )
        ) : isLoading ? <Spinner /> : !cands.length ? (
          !sug && <p className="py-4 text-center text-xs text-zinc-400">{t('finances.bank.noCandidatesHint')}</p>
        ) : (
          <>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t(sug ? 'finances.bank.otherCandidates' : 'finances.bank.suggestedMatches')}</div>
            <ul className="-mx-1 flex max-h-[55vh] flex-col divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">{cands.map(row)}</ul>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Give an open bank line a home when no scan exists: generate a stand-in receipt
 *  (forgotten purchase) or a fixed-cost entry (one-off transfer/top-up). */
function BankGenerateModal({ tx, t, onClose, onDone }: {
  tx: BankTx; t: (k: string, o?: Record<string, unknown>) => string; onClose: () => void; onDone: () => void;
}) {
  const navigate = useNavigate();
  const credit = tx.amount > 0;
  const debit = tx.amount < 0; // only true outflows can become a purchase receipt
  const [mode, setMode] = useState<'einkauf' | 'fixed'>(debit ? 'einkauf' : 'fixed');
  const [laden, setLaden] = useState(tx.counterparty ?? '');
  const [label, setLabel] = useState(tx.counterparty ?? '');
  const [kind, setKind] = useState<'expense' | 'income'>(credit ? 'income' : 'expense');
  // A homed CREDIT is almost always an internal top-up/transfer → default the
  // Umbuchung guard ON so it doesn't inflate the month's income total.
  const [isTransfer, setIsTransfer] = useState(credit);
  const [oneMonth, setOneMonth] = useState(true);

  // The bank counterparty prefilled into `laden` is usually the wrong store name;
  // offer existing store/shop names as autocomplete when the user corrects it.
  const { data: stores } = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<{ display: string; raw?: string[]; filialen?: { name: string }[] }[]>('/api/stores'),
  });
  const storeNames = useMemo(() => {
    const set = new Set<string>();
    for (const s of stores ?? []) {
      (s.filialen ?? []).forEach(f => f.name && set.add(f.name));
      s.raw?.forEach(r => r && set.add(r));
      if (s.display) set.add(s.display);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [stores]);

  const genReceipt = useMutation({
    mutationFn: () => api<{ ok: boolean; einkauf_id: number }>(`/api/finances/bank/${tx.id}/generate-receipt`, { method: 'POST', body: { laden: laden.trim() } }),
    // Jump straight into the freshly generated receipt so the user can review/fix it
    // (rename, correct the Konto, add real items) instead of hunting for it in Belege.
    onSuccess: (r) => { toast(t('finances.bank.gen.createdReceipt'), 'success'); onDone(); if (r?.einkauf_id) navigate(`/receipts/${r.einkauf_id}`); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const genFixed = useMutation({
    mutationFn: () => api(`/api/finances/bank/${tx.id}/generate-fixed`, { method: 'POST', body: { label: label.trim(), kind, is_transfer: isTransfer, one_month: oneMonth } }),
    onSuccess: () => { toast(t('finances.bank.gen.createdFixed'), 'success'); onDone(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const busy = genReceipt.isPending || genFixed.isPending;

  return (
    <Modal open onClose={onClose} title={t('finances.bank.gen.title')}>
      <div className="flex flex-col gap-3">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{tx.counterparty || '—'} · {eur(tx.amount)} · {ddmmyyyy(tx.booking_date)}</div>
        <div className="flex gap-1.5">
          {(debit ? (['einkauf', 'fixed'] as const) : (['fixed'] as const)).map(m => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={cn('flex-1 rounded-xl border px-3 py-2 text-sm font-medium',
                mode === m ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>
              {t(`finances.bank.gen.${m}`)}
            </button>
          ))}
        </div>
        {mode === 'einkauf' ? (
          <>
            <div>
              <Label>{t('finances.bank.gen.laden')}</Label>
              <Input value={laden} list="bank-gen-store-suggestions" onChange={e => setLaden(e.target.value)} placeholder={tx.counterparty ?? ''} />
              <datalist id="bank-gen-store-suggestions">
                {storeNames.map(n => <option key={n} value={n} />)}
              </datalist>
            </div>
            <p className="text-xs text-zinc-400">{t('finances.bank.gen.receiptHint', { v: eur(Math.abs(tx.amount)) })}</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
              <Button onClick={() => genReceipt.mutate()} disabled={busy}>{t('finances.bank.gen.createReceipt')}</Button>
            </div>
          </>
        ) : (
          <>
            <div>
              <Label>{t('finances.label')}</Label>
              <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={tx.counterparty ?? ''} />
            </div>
            <div className="flex gap-1.5">
              {(['expense', 'income'] as const).map(k => (
                <button key={k} type="button" onClick={() => setKind(k)}
                  className={cn('flex-1 rounded-xl border px-3 py-2 text-sm font-medium',
                    kind === k ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>
                  {k === 'income' ? t('finances.incomeTitle') : t('finances.fixTitle')}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Switch checked={oneMonth} onChange={setOneMonth} /> {t('finances.bank.gen.oneMonth')}
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Switch checked={isTransfer} onChange={setIsTransfer} /> {t('finances.transferLabel')}
            </label>
            <p className="text-xs text-zinc-400">{t('finances.bank.gen.fixedHint', { v: eur(Math.abs(tx.amount)) })}</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
              <Button onClick={() => genFixed.mutate()} disabled={busy || !label.trim()}>{t('finances.bank.gen.createFixed')}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

interface ImportBatch {
  batch: string; filename: string; konto_id: number | null; konto_name: string | null;
  n: number; imported_at: string | null; first_date: string; last_date: string;
}

/** Compact list of imported CSV batches (filename · account · count · import date),
 *  each with an "undo import" button — for the common slip of importing a CSV onto
 *  the wrong account. Undo deletes exactly that import's rows; any receipts it had
 *  matched just lose the bank link (FK SET NULL) and re-match on a correct re-import. */
function ImportBatches({ t }: { t: (k: string, o?: Record<string, unknown>) => string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['bank-batches'], queryFn: () => api<{ batches: ImportBatch[] }>('/api/finances/bank/batches') });
  const undo = useMutation({
    mutationFn: (batch: string) => api<{ ok: boolean; deleted: number; unlinked: number }>('/api/finances/bank/undo-import', { method: 'POST', body: { batch } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bank-batches'] });
      void qc.invalidateQueries({ queryKey: ['bank-tx'] });
      void qc.invalidateQueries({ queryKey: ['fin-month'] });
    },
  });
  const batches = data?.batches ?? [];
  if (!batches.length) return null;
  const onUndo = async (b: ImportBatch) => {
    const ok = await confirm({
      title: t('finances.bank.undoTitle'),
      message: t('finances.bank.undoMsg', { file: b.filename, konto: b.konto_name ?? '—', count: b.n }),
      confirmLabel: t('finances.bank.undoConfirm'), cancelLabel: t('common.cancel'),
    });
    if (ok) undo.mutate(b.batch);
  };
  return (
    <div className="rounded-xl border border-zinc-200 p-2.5 dark:border-zinc-800">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.bank.imports')}</div>
      <ul className="flex flex-col gap-1">
        {batches.map(b => (
          <li key={b.batch} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <FileText size={12} className="shrink-0 text-zinc-400" />
            <span className="min-w-0 flex-1 truncate" title={b.filename}>{b.filename}</span>
            {b.konto_name && <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{b.konto_name}</span>}
            <span className="shrink-0 tabular-nums text-zinc-400">{b.n}</span>
            <span className="shrink-0 tabular-nums text-zinc-400" title={t('finances.bank.importedOn')}>{b.imported_at ? ddmmyyyy(b.imported_at.slice(0, 10)) : '–'}</span>
            <button type="button" onClick={() => void onUndo(b)} disabled={undo.isPending}
              title={t('finances.bank.undo')} aria-label={t('finances.bank.undo')}
              className="shrink-0 rounded p-0.5 text-zinc-400 transition-colors hover:text-red-600 disabled:opacity-40 dark:hover:text-red-400">
              <Undo2 size={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BankTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: konten } = useKonten();
  const scopeKonten = useMemo(() => (konten ?? []).filter(k => !k.is_cash), [konten]);
  const [konto, setKonto] = useUrlState('bk', '');
  const [month, setMonth] = useUrlState('bm', '');
  const [status, setStatus] = useUrlState('bs', 'all');
  const [search, setSearch] = useUrlState('bq', '');
  const [highlightId] = useUrlState('bhl', ''); // deep-link: highlight one booking
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [linkTx, setLinkTx] = useState<BankTx | null>(null);
  const [genTx, setGenTx] = useState<BankTx | null>(null);
  const qs = new URLSearchParams();
  if (konto) qs.set('konto', konto);
  if (month) qs.set('month', month);
  if (status !== 'all') qs.set('status', status);
  if (search.trim()) qs.set('q', search.trim());
  const { data, isLoading } = useQuery({
    queryKey: ['bank-tx', konto, month, status, search],
    queryFn: () => api<{ items: BankTx[]; counts: { all: number; open: number; fixed: number; receipt: number; income: number } }>(`/api/finances/bank?${qs.toString()}`),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['bank-tx'] });
    void qc.invalidateQueries({ queryKey: ['bank-candidates'] });
  };
  const flag = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) => api(`/api/finances/bank/${id}/flag`, { method: 'POST', body: { flag: on } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bank-tx'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const link = useMutation({
    // Debit → receipt (einkauf_id); credit → income row (income_id).
    mutationFn: (id: number) => api(`/api/finances/bank/${linkTx!.id}/link`, { method: 'POST', body: linkTx!.amount > 0 ? { income_id: id } : { einkauf_id: id } }),
    onSuccess: () => { invalidate(); setLinkTx(null); toast(t('finances.bank.linkedToast'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const unlink = useMutation({
    mutationFn: (id: number) => api(`/api/finances/bank/${id}/unlink`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const rematch = useMutation({
    mutationFn: () => api<{ linked: number; suggested: number }>('/api/finances/bank/rematch', { method: 'POST', body: { konto_id: konto ? Number(konto) : null } }),
    onSuccess: (r) => { invalidate(); toast(t('finances.bank.rematchToast', { n: r.linked, s: r.suggested }), (r.linked || r.suggested) ? 'success' : 'info'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const approve = useMutation({
    mutationFn: (id: number) => api(`/api/finances/bank/${id}/suggestion/approve`, { method: 'POST' }),
    onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['fin-month'] }); toast(t('finances.bank.approvedToast'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const dismiss = useMutation({
    mutationFn: (id: number) => api(`/api/finances/bank/${id}/suggestion/dismiss`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bank-tx'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const items = data?.items ?? [];
  const c = data?.counts;
  const chips: { key: 'all' | 'open' | 'fixed' | 'receipt' | 'income'; n?: number }[] = [
    { key: 'all', n: c?.all }, { key: 'open', n: c?.open }, { key: 'receipt', n: c?.receipt }, { key: 'income', n: c?.income }, { key: 'fixed', n: c?.fixed },
  ];
  const hasActiveFilters = !!konto || !!month || status !== 'all';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <Input className="pl-9 pr-9" placeholder={t('finances.bank.search')} value={search} onChange={e => setSearch(e.target.value)} />
            {search && (
              <button onClick={() => setSearch('')} title={t('common.clear')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
                <X size={15} />
              </button>
            )}
          </div>
          <button type="button" onClick={() => setFiltersOpen(o => !o)} title={t('receipts.filters')} aria-pressed={filtersOpen}
            className={cn('relative flex shrink-0 items-center rounded-xl border px-2.5 py-2 transition',
              filtersOpen ? 'border-emerald-500 bg-emerald-50 text-emerald-600 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
                : 'border-zinc-200 text-zinc-400 hover:text-zinc-600 dark:border-zinc-800')}>
            <SlidersHorizontal size={16} />
            {hasActiveFilters && !filtersOpen && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-950" />}
          </button>
        </div>
        {filtersOpen && (
          <>
            {/* Stacks on mobile so the account name isn't truncated ("all accoun…") and
                the clear-✕ never overlaps the native month picker's own dropdown arrow. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Select value={konto} onChange={e => setKonto(e.target.value)} className="w-full min-w-0 sm:flex-1">
                <option value="">{t('finances.bank.allKonten')}</option>
                {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
              </Select>
              <div className="flex items-center gap-2">
                {/* Calendar icon is on the LEFT only (the native picker's own control is on
                    the right); the clear-✕ is a SEPARATE button, never overlapping it. */}
                <div className="relative min-w-0 flex-1 sm:w-[10.5rem] sm:flex-none">
                  <Calendar size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                  <Input type="month" value={month} onChange={e => setMonth(e.target.value)} aria-label={t('finances.bank.monthFilter')}
                    className="w-full cursor-pointer pl-8" title={t('finances.bank.monthFilter')} />
                </div>
                {month && <button type="button" onClick={() => setMonth('')} title={t('common.clear')}
                  className="shrink-0 rounded-xl border border-zinc-200 p-2 text-zinc-400 hover:text-zinc-600 dark:border-zinc-800 dark:hover:text-zinc-200"><X size={15} /></button>}
                <button onClick={() => rematch.mutate()} disabled={rematch.isPending} title={t('finances.bank.rematch')}
                  className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-zinc-300 px-2.5 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                  <RefreshCw size={14} className={cn(rematch.isPending && 'animate-spin')} /> {t('finances.bank.rematch')}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {chips.map(ch => (
                <button key={ch.key} onClick={() => setStatus(ch.key)}
                  className={cn('rounded-full border px-2.5 py-1 text-xs font-medium',
                    status === ch.key ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300')}>
                  {t(`finances.bank.filter_${ch.key}`)}{ch.n != null ? ` · ${ch.n}` : ''}
                </button>
              ))}
            </div>
            <ImportBatches t={t} />
          </>
        )}
      </div>
      {isLoading ? <Spinner /> : !items.length ? (
        <Card className="p-4 text-center text-xs text-zinc-400">{search ? t('finances.bank.noSearchResults') : t('finances.bank.empty')}</Card>
      ) : (
        <>
          <p className="-mb-1 text-[11px] text-zinc-400">{t('finances.bank.flagHint')}</p>
          <div className="flex flex-col gap-2">
            {items.map(tx => <BankRow key={tx.id} tx={tx} t={t} highlight={highlightId !== '' && String(tx.id) === highlightId} onOpen={id => navigate(`/receipts/${id}`)} onOpenFixed={b => navigate(`/finanzen?tab=monat&m=${b.fixed!.month}&fx=${b.fixed!.id}`)} onLink={setLinkTx} onUnlink={unlink.mutate} onFlag={(id, on) => flag.mutate({ id, on })} onGenerate={setGenTx} onApprove={approve.mutate} onDismiss={dismiss.mutate} />)}
          </div>
        </>
      )}
      {linkTx && <BankLinkPicker tx={linkTx} t={t} onClose={() => setLinkTx(null)} onPick={link.mutate} onApprove={approve.mutate} />}
      {genTx && <BankGenerateModal tx={genTx} t={t} onClose={() => setGenTx(null)}
        onDone={() => {
          setGenTx(null);
          invalidate();
          void qc.invalidateQueries({ queryKey: ['fixed-costs'] });
          void qc.invalidateQueries({ queryKey: ['fin-month'] });
          void qc.invalidateQueries({ queryKey: ['receipts'] });
        }} />}
    </div>
  );
}

/** A one-off = a single-month bounded fixed_cost (start & end in the same month), e.g. a
 *  generated one-time income ("…Spesen") or cost. Not a recurring plan → kept OUT of the
 *  manage lists; it lives in its month in the Monat view (+ a collapsed section here). */
// A one-off is an explicit flag now (set by the generate / bank-pairing flows), NOT
// derived from the dates — so a recurring plan that merely got an end date within its
// start month is no longer mis-classified as a settled one-off.
const isOneOff = (c: FixedCost): boolean => c.one_off === true;

/** Collapsible card with a uniform header (icon · title · badge · right meta · +add · chevron).
 *  Shared by the fixed-income, per-account fixed-cost, and inactive sections so the whole
 *  Verwaltung page reads coherently. */
function CollapseCard({ icon, title, badge, right, onAdd, addTitle, defaultOpen = false, dashed = false, children }: {
  icon: ReactNode; title: ReactNode; badge?: number; right?: ReactNode; onAdd?: () => void; addTitle?: string; defaultOpen?: boolean; dashed?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('overflow-hidden rounded-xl border', dashed ? 'border-dashed border-zinc-300 dark:border-zinc-700' : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900')}>
      <div className="flex items-center gap-2 p-3">
        <button onClick={() => setOpen(o => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="shrink-0">{icon}</span>
          <span className="truncate text-sm font-medium">{title}</span>
          {badge != null && <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{badge}</span>}
          {right != null && <span className="ml-auto shrink-0 pl-2">{right}</span>}
        </button>
        {onAdd && (
          <button onClick={onAdd} title={addTitle} className="shrink-0 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800">
            <Plus size={16} />
          </button>
        )}
        <button onClick={() => setOpen(o => !o)} className="shrink-0 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="toggle">
          <ChevronDown size={16} className={cn('transition-transform', !open && '-rotate-90')} />
        </button>
      </div>
      {open && <div className={cn('flex flex-col gap-2 px-3 pb-3', !dashed && 'border-t border-zinc-100 pt-3 dark:border-zinc-800')}>{children}</div>}
    </div>
  );
}

/** One recurring fixed-cost / fixed-income row (used in every Verwaltung list). */
function FixRow({ c, t, onEdit, onDelete }: {
  c: FixedCost; t: (k: string, o?: Record<string, unknown>) => string; onEdit: (c: FixedCost) => void; onDelete: (c: FixedCost) => void;
}) {
  return (
    <Card className={cn('flex items-center gap-3 p-3', !c.active && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{c.label}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
          {c.kind === 'income' && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">{t('finances.incomeTitle')}</span>}
          {c.is_transfer && <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{t('finances.transferBadge')}</span>}
          {c.counterpart_label && <span className="truncate text-violet-600 dark:text-violet-400" title={c.counterpart_konto ?? undefined}>↔ {c.counterpart_label}</span>}
          {c.frequency !== 'monthly' && <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">{t(`finances.freq.${c.frequency}`)} · {eur(c.monthly_eur)}</span>}
          {c.category_path && <span className="truncate">{c.category_path.split('/').pop()}</span>}
          {!c.expect_receipt && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t('finances.noReceiptBadge')}</span>}
          {!c.active && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t('finances.inactive')}</span>}
          {c.start_date && c.start_date > today() && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{t('finances.from')} {ddmmyyyy(c.start_date)}</span>}
          {c.end_date && <span>{t('finances.until')} {ddmmyyyy(c.end_date)}</span>}
        </div>
      </div>
      <span className={cn('shrink-0 text-sm font-semibold', c.kind === 'income' && 'text-emerald-600 dark:text-emerald-500')}>{c.kind === 'income' ? '+' : ''}{eur(amortized(c.monthly_eur, c.frequency))}<span className="text-xs font-normal text-zinc-400">{t('finances.perMonth')}</span></span>
      <button onClick={() => onEdit(c)} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" title={t('common.edit')}><Pencil size={15} /></button>
      <button onClick={() => onDelete(c)} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30" title={t('common.delete')}><Trash2 size={15} /></button>
    </Card>
  );
}

/** Bank-statement bookings from CSV imports, one direction (in = credits, out = debits),
 *  filterable by the account they belong to. The `+` opens the bank-CSV upload popup.
 *  Shares the ['bank-tx'] cache so a CSV upload refreshes it automatically. */
function BankMovements({ direction, ownerKeys, onUpload }: { direction: 'in' | 'out'; ownerKeys: string[]; onUpload: () => void }) {
  const { t } = useTranslation();
  const [konto, setKonto] = useState('');
  const { data } = useQuery({ queryKey: ['bank-tx', 'all'], queryFn: () => api<{ items: BankTx[] }>('/api/finances/bank') });
  const dir = useMemo(() => (data?.items ?? []).filter(x => direction === 'in' ? x.amount > 0 : x.amount < 0), [data, direction]);
  // A booking whose counterparty is one of the household's OWN account holders is an
  // internal transfer (e.g. Martin → Haushaltskonto): shown greyed but NOT counted, so both
  // legs net out and the total isn't inflated. Detection is data-driven from the konto owners.
  const isTransfer = (x: BankTx) => {
    const c = (x.counterparty ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return !!c && ownerKeys.some(k => k && c.includes(k));
  };
  // Accounts that actually have a booking of this direction (cash accounts never appear —
  // bank_tx only exist for CSV-imported bank accounts).
  const accounts = useMemo(() => {
    const m = new Map<number, string>();
    for (const x of dir) if (x.konto_id != null) m.set(x.konto_id, x.konto_name ?? String(x.konto_id));
    return [...m.entries()].map(([id, name]) => ({ id: String(id), name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [dir]);
  const rows = useMemo(() => dir.filter(x => !konto || String(x.konto_id) === konto), [dir, konto]);
  useEffect(() => { if (konto && !accounts.some(a => a.id === konto)) setKonto(''); }, [accounts, konto]);
  const absTotal = Math.abs(rows.filter(x => !isTransfer(x)).reduce((s, x) => s + x.amount, 0));

  return (
    <CollapseCard
      icon={direction === 'in'
        ? <ArrowDownLeft size={17} className="text-emerald-600 dark:text-emerald-500" />
        : <ArrowUpRight size={17} className="text-emerald-600 dark:text-emerald-500" />}
      title={t(direction === 'in' ? 'finances.incomeActualTitle' : 'finances.bankOutTitle')}
      right={<span className={cn('text-sm font-medium', direction === 'in' && 'text-emerald-600 dark:text-emerald-500')}>{direction === 'in' ? '+' : '−'}{eur(absTotal)}</span>}
      onAdd={onUpload}
      addTitle={t('finances.bank.heading')}
    >
      <div className="flex gap-2">
        <Select value={konto} onChange={e => setKonto(e.target.value)}>
          <option value="">{t('finances.allAccounts')}</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </div>
      {rows.length === 0
        ? <p className="text-xs text-zinc-400">{t('finances.bankMovesEmpty')}</p>
        : (
          <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.slice(0, 100).map(x => {
              const tr = isTransfer(x);
              return (
                <li key={x.id} className={cn('flex items-center gap-3 py-2', tr && 'opacity-50')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm">{x.counterparty || x.description || '—'}</span>
                      {tr && <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{t('finances.transferBadge')}</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{ddmmyyyy(x.booking_date)}{x.konto_name ? ` · ${x.konto_name}` : ''}</div>
                  </div>
                  <span className={cn('shrink-0 text-sm font-medium', !tr && x.amount > 0 && 'text-emerald-600 dark:text-emerald-500')}>{x.amount > 0 ? '+' : '−'}{eur(Math.abs(x.amount))}</span>
                </li>
              );
            })}
          </ul>
        )}
      {rows.length > 100 && <p className="pt-1 text-[11px] text-zinc-400">{t('finances.bankShowingFirst', { total: rows.length })}</p>}
    </CollapseCard>
  );
}

/** One member's (or the household's) recurring fixed costs, with a per-account chip
 *  filter when the member has more than one CSV bank account. */
function MemberFixGroup({ label, isHome, konten, items, t, onAdd, onEdit, onDelete }: {
  label: string; isHome: boolean; konten: KontoLite[]; items: FixedCost[];
  t: (k: string, o?: Record<string, unknown>) => string;
  onAdd: (kontoId?: number) => void; onEdit: (c: FixedCost) => void; onDelete: (c: FixedCost) => void;
}) {
  const [konto, setKonto] = useState<number | 'all'>('all');
  const eff: number | 'all' = konto !== 'all' && konten.some(k => k.id === konto) ? konto : 'all';
  const shown = eff === 'all' ? items : items.filter(c => c.konto_id === eff);
  const sum = shown.filter(c => !c.is_transfer).reduce((s, c) => s + amortized(c.monthly_eur, c.frequency), 0);
  const chip = (active: boolean, onClick: () => void, text: string) => (
    <button type="button" onClick={onClick} className={cn(
      'shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
      active ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400',
    )}>{text}</button>
  );
  return (
    <CollapseCard
      icon={isHome ? <Home size={17} className="text-emerald-600 dark:text-emerald-500" /> : <UserIcon size={17} className="text-emerald-600 dark:text-emerald-500" />}
      title={label}
      right={<span className="text-sm font-medium">{eur(sum)}<span className="text-[11px] font-normal text-zinc-400">{t('finances.perMonth')}</span></span>}
      onAdd={() => onAdd(eff === 'all' ? konten[0]?.id : eff)}
      addTitle={t('finances.add')}
    >
      {konten.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {chip(eff === 'all', () => setKonto('all'), t('finances.allAccounts'))}
          {konten.map(k => chip(eff === k.id, () => setKonto(k.id), k.name))}
        </div>
      )}
      {shown.length === 0
        ? <Card className="p-3 text-xs text-zinc-400">{t('finances.emptyScope')}</Card>
        : shown.map(c => <FixRow key={c.id} c={c} t={t} onEdit={onEdit} onDelete={onDelete} />)}
    </CollapseCard>
  );
}

function ManageTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [modal, setModal] = useState<Draft | null>(null);
  const [showInfo, setShowInfo] = useState(false); // Fixkosten info text collapsed behind the (i)
  const [csvOpen, setCsvOpen] = useState(false); // bank-statement CSV upload popup
  const [pdfOpen, setPdfOpen] = useState(false); // salary pay-slip PDF upload popup
  // Bank-CSV import is off on the public demo — a statement is the most sensitive file a
  // visitor could hand an anonymous 24h account. The backend refuses /bank/analyze and
  // /bank/upload with 403 regardless; this just avoids offering a button that cannot work.
  const { demo } = useAuth();

  const { data: costs, isLoading } = useQuery({ queryKey: ['fixed-costs'], queryFn: () => api<FixedCost[]>('/api/fixed-costs') });
  const { data: konten } = useKonten();
  const { data: bankData } = useQuery({ queryKey: ['bank-tx', 'all'], queryFn: () => api<{ items: BankTx[] }>('/api/finances/bank') });

  // Scope options: every non-cash account. Shared = household (rent, loan…),
  // the rest = per person/account. Cash accounts don't carry standing costs.
  const scopeKonten = useMemo(() => (konten ?? []).filter(k => !k.is_cash), [konten]);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['fixed-costs'] });
    void qc.invalidateQueries({ queryKey: ['fin-month'] });
    // A fixed cost can carry a bank-tx link (generate-fixed), so its create/edit/
    // delete changes an Auszüge line's status — keep that list fresh too.
    void qc.invalidateQueries({ queryKey: ['bank-tx'] });
  };

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = {
        label: d.label.trim(),
        monthly_eur: d.monthly_eur,
        kind: d.kind,
        frequency: d.frequency,
        is_transfer: d.is_transfer,
        konto_id: Number(d.konto_id),
        category_path: d.category_path,
        start_date: d.start_date,
        end_date: d.end_date || null,
        active: d.active,
        expect_receipt: d.expect_receipt,
        match_merchant: d.match_merchant.trim() || null,
        // Only send the pairing on an existing transfer: on PATCH it preserves
        // (or re-sets) the link; a brand-new row can't pair before it has an id.
        ...(d.id ? { counterpart_id: d.is_transfer ? d.counterpart_id : null } : {}),
      };
      return d.id
        ? api(`/api/fixed-costs/${d.id}`, { method: 'PATCH', body })
        : api('/api/fixed-costs', { method: 'POST', body });
    },
    onSuccess: () => { invalidate(); setModal(null); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const readd = useMutation({
    mutationFn: (c: FixedCost) => api('/api/fixed-costs', {
      method: 'POST',
      body: { label: c.label, monthly_eur: c.monthly_eur, kind: c.kind, frequency: c.frequency, is_transfer: c.is_transfer, konto_id: c.konto_id, category_path: c.category_path, start_date: c.start_date, end_date: c.end_date, active: c.active, expect_receipt: c.expect_receipt, match_merchant: c.match_merchant, one_off: c.one_off },
    }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (c: FixedCost) => api(`/api/fixed-costs/${c.id}`, { method: 'DELETE' }),
    onSuccess: (_r, c) => {
      invalidate();
      toast(t('finances.removedToast', { label: c.label }), 'info', 6000, { label: t('finances.undo'), onClick: () => readd.mutate(c) });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // Single-month one-offs live in their month (Monat view) + a collapsed section below,
  // newest first — kept separate from the recurring plans (their own future epic).
  const oneOffs = useMemo(() => (costs ?? []).filter(isOneOff).sort((a, b) => b.start_date.localeCompare(a.start_date)), [costs]);

  // Recurring plans split three ways: active income (own section), active expense
  // (grouped by account), and everything inactive (collapsed archive) — kept in the DB.
  const recurring = useMemo(() => (costs ?? []).filter(c => !isOneOff(c)), [costs]);
  const fixedIncomes = useMemo(() => recurring.filter(c => c.active && c.kind === 'income').sort((a, b) => a.label.localeCompare(b.label)), [recurring]);
  const inactive = useMemo(() => recurring.filter(c => !c.active).sort((a, b) => a.label.localeCompare(b.label)), [recurring]);

  // Accounts that have ever seen a CSV bank booking — used to decide which members appear
  // under Fixkosten ("who has ever incurred a booking"), never hardcoded to a household.
  const bookedKontoIds = useMemo(
    () => new Set((bankData?.items ?? []).map(x => x.konto_id).filter((v): v is number => v != null)),
    [bankData],
  );

  // Group ACTIVE recurring EXPENSES by MEMBER: household (shared) first, then each person
  // who has a fixed cost or a bank booking. A member's accounts become a per-account chip
  // filter inside their group (each has one in our case, but it scales to several).
  const memberKeyOf = (k: KontoLite) => k.is_shared ? 'home' : (k.user_id != null ? `u${k.user_id}` : `o:${k.owner ?? k.name}`);
  const memberGroups = useMemo(() => {
    type MG = { key: string; label: string; isHome: boolean; sortOwner: string; konten: KontoLite[]; items: FixedCost[] };
    const byMember = new Map<string, MG>();
    for (const k of scopeKonten) {
      const key = memberKeyOf(k);
      if (!byMember.has(key)) byMember.set(key, { key, label: scopeLabelOf(t, k), isHome: !!k.is_shared, sortOwner: k.is_shared ? '' : (k.owner ?? ''), konten: [], items: [] });
      byMember.get(key)!.konten.push(k);
    }
    const kontoToMember = new Map<number, string>();
    for (const k of scopeKonten) kontoToMember.set(k.id, memberKeyOf(k));
    // Fallback bucket so a cost whose account isn't in scope (e.g. a giro account later
    // re-flagged as cash, or a null konto) stays visible + editable AND the header total
    // keeps reconciling with the sum of the shown subtotals.
    const ensureOther = () => {
      const KEY = '__other__';
      if (!byMember.has(KEY)) byMember.set(KEY, { key: KEY, label: t('finances.otherScope'), isHome: false, sortOwner: '￿', konten: [], items: [] });
      return byMember.get(KEY)!;
    };
    for (const c of recurring.filter(c => c.active && c.kind !== 'income')) {
      const key = c.konto_id != null ? kontoToMember.get(c.konto_id) : undefined;
      if (key && byMember.has(key)) byMember.get(key)!.items.push(c);
      else ensureOther().items.push(c);
    }
    return [...byMember.values()]
      .filter(m => m.items.length > 0 || m.konten.some(k => bookedKontoIds.has(k.id)))
      .sort((a, b) => (b.isHome ? 1 : 0) - (a.isHome ? 1 : 0) || a.sortOwner.localeCompare(b.sortOwner));
  }, [recurring, scopeKonten, bookedKontoIds, t]);

  // Household-wide recurring total: active expenses only, excludes internal transfers.
  const monthlyTotal = recurring.filter(c => c.active && c.kind !== 'income' && !c.is_transfer).reduce((s, c) => s + amortized(c.monthly_eur, c.frequency), 0);
  const fixedIncomeTotal = fixedIncomes.filter(c => !c.is_transfer).reduce((s, c) => s + amortized(c.monthly_eur, c.frequency), 0);

  if (isLoading || !konten) return <Spinner />;

  return (
    <div className="flex flex-col gap-4">
      {/* Import: bank statements (CSV) + salary pay slips (PDF) — the page's main job. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] font-medium text-zinc-400">{t('finances.importLabel')}</span>
        {!demo && <Button variant="secondary" onClick={() => setCsvOpen(true)}><Upload size={15} /> {t('finances.bank.heading')}</Button>}
        <Button variant="secondary" onClick={() => setPdfOpen(true)}><FileText size={15} /> {t('finances.income.heading')}</Button>
      </div>

      <CollapseCard
        icon={<TrendingUp size={17} className="text-emerald-600 dark:text-emerald-500" />}
        title={t('finances.fixedIncomeTitle')}
        badge={fixedIncomes.length}
        right={<span className="text-sm font-medium text-emerald-600 dark:text-emerald-500">+{eur(fixedIncomeTotal)}<span className="text-[11px] font-normal text-zinc-400">{t('finances.perMonth')}</span></span>}
        onAdd={() => setModal(emptyDraft(scopeKonten[0]?.id, 'income'))}
        addTitle={t('finances.add')}
      >
        {fixedIncomes.length === 0
          ? <Card className="p-3 text-xs text-zinc-400">{t('finances.noIncomePlans')}</Card>
          : fixedIncomes.map(c => <FixRow key={c.id} c={c} t={t} onEdit={fc => setModal(draftFromCost(fc))} onDelete={fc => remove.mutate(fc)} />)}
      </CollapseCard>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 px-1">
          <span className="text-[11px] font-medium text-zinc-400">{t('finances.fixedCostsTitle')}</span>
          <span className="text-[11px] text-zinc-400">· {eur(monthlyTotal)}{t('finances.perMonth')}</span>
          <button onClick={() => setShowInfo(s => !s)} className="rounded p-0.5 text-zinc-400 hover:text-sky-500" title={t('finances.hint')} aria-label="info">
            <Info size={13} />
          </button>
        </div>
        {showInfo && (
          <Card className="flex items-start gap-3 p-3 text-xs text-zinc-500 dark:text-zinc-400">
            <Info size={16} className="mt-0.5 shrink-0 text-sky-500" />
            <span>{t('finances.hint')}</span>
          </Card>
        )}
        {memberGroups.map(m => (
          <MemberFixGroup key={m.key} label={m.label} isHome={m.isHome} konten={m.konten} items={m.items} t={t}
            onAdd={kid => setModal(emptyDraft(kid, 'expense'))}
            onEdit={fc => setModal(draftFromCost(fc))}
            onDelete={fc => remove.mutate(fc)} />
        ))}
        {inactive.length > 0 && (
          <CollapseCard dashed
            icon={<Archive size={17} className="text-emerald-600 dark:text-emerald-500" />}
            title={<span className="text-zinc-500 dark:text-zinc-400">{t('finances.inactiveTitle')}</span>}
            badge={inactive.length}
          >
            {inactive.map(c => <FixRow key={c.id} c={c} t={t} onEdit={fc => setModal(draftFromCost(fc))} onDelete={fc => remove.mutate(fc)} />)}
          </CollapseCard>
        )}
      </div>
      {!memberGroups.some(m => m.items.length) && !fixedIncomes.length && !inactive.length && !oneOffs.length && <EmptyState>{t('finances.empty')}</EmptyState>}

      {oneOffs.length > 0 && (
        <CollapseCard icon={<Zap size={17} className="text-emerald-600 dark:text-emerald-500" />} title={t('finances.oneOffTitle')} badge={oneOffs.length}>
          {oneOffs.map(c => (
            <Card key={c.id} className={cn('flex items-center gap-3 p-3', !c.active && 'opacity-50')}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.label}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px]', c.kind === 'income' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-zinc-100 dark:bg-zinc-800')}>{c.kind === 'income' ? t('finances.incomeTitle') : t('finances.fixTitle')}</span>
                  <span>{c.start_date.slice(5, 7)}/{c.start_date.slice(0, 4)}</span>
                  {c.konto_name && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{c.konto_name}</span>}
                  {c.is_transfer && <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{t('finances.transferBadge')}</span>}
                </div>
              </div>
              <span className={cn('shrink-0 text-sm font-semibold', c.kind === 'income' && 'text-emerald-600 dark:text-emerald-500')}>{c.kind === 'income' ? '+' : ''}{eur(c.monthly_eur)}</span>
              <button onClick={() => setModal({ id: c.id, label: c.label, monthly_eur: String(c.monthly_eur).replace('.', ','), kind: c.kind, frequency: c.frequency, is_transfer: c.is_transfer, konto_id: String(c.konto_id ?? ''), category_path: c.category_path, start_date: c.start_date, end_date: c.end_date ?? '', active: c.active, expect_receipt: c.expect_receipt, match_merchant: c.match_merchant ?? '', counterpart_id: c.counterpart_id })}
                className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" title={t('common.edit')}><Pencil size={15} /></button>
              <button onClick={() => remove.mutate(c)} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30" title={t('common.delete')}><Trash2 size={15} /></button>
            </Card>
          ))}
        </CollapseCard>
      )}

      {csvOpen && !demo && (
        <Modal open onClose={() => setCsvOpen(false)} title={t('finances.bank.heading')}>
          <BankUpload scopeKonten={scopeKonten} embedded />
        </Modal>
      )}
      {pdfOpen && (
        <Modal open onClose={() => setPdfOpen(false)} title={t('finances.income.heading')}>
          <PayslipUpload scopeKonten={scopeKonten} embedded />
        </Modal>
      )}

      {modal && (
        <Modal open onClose={() => setModal(null)} title={modal.id ? t('finances.editTitle') : t('finances.addTitle')}>
          <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (modal.label.trim() && modal.monthly_eur && modal.konto_id) save.mutate(modal); }}>
            <div className="flex gap-1.5">
              {(['expense', 'income'] as const).map(k => (
                <button key={k} type="button" onClick={() => setModal({ ...modal, kind: k })}
                  className={cn('flex-1 rounded-xl border px-3 py-2 text-sm font-medium',
                    modal.kind === k ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>
                  {k === 'income' ? t('finances.incomeTitle') : t('finances.fixTitle')}
                </button>
              ))}
            </div>
            <div>
              <Label>{t('finances.label')}</Label>
              <Input autoFocus value={modal.label} onChange={e => setModal({ ...modal, label: e.target.value })} placeholder={t('finances.labelPlaceholder')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('finances.amount')}</Label>
                <Input inputMode="decimal" value={modal.monthly_eur} onChange={e => setModal({ ...modal, monthly_eur: e.target.value })} placeholder="0,00" />
                {modal.frequency !== 'monthly' && modal.monthly_eur && (
                  <p className="mt-1 text-[11px] text-zinc-400">{t('finances.amortizedHint', { v: eur(amortized(parseFloat(modal.monthly_eur.replace(',', '.')) || 0, modal.frequency)) })}</p>
                )}
              </div>
              <div>
                <Label>{t('finances.frequency')}</Label>
                <Select value={modal.frequency} onChange={e => setModal({ ...modal, frequency: e.target.value as Freq })}>
                  <option value="monthly">{t('finances.freq.monthly')}</option>
                  <option value="quarterly">{t('finances.freq.quarterly')}</option>
                  <option value="yearly">{t('finances.freq.yearly')}</option>
                </Select>
              </div>
            </div>
            <div>
              <Label>{t('finances.scope')}</Label>
              <Select value={modal.konto_id} onChange={e => setModal({ ...modal, konto_id: e.target.value })}>
                <option value="" disabled>–</option>
                {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
              </Select>
            </div>
            <div>
              <Label>{t('finances.category')} <span className="text-zinc-400">({t('common.optional')})</span></Label>
              <CategoryPicker value={modal.category_path} onChange={p => setModal({ ...modal, category_path: p })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('finances.startDate')}</Label>
                <Input type="date" value={modal.start_date} onChange={e => setModal({ ...modal, start_date: e.target.value })} />
              </div>
              <div>
                <Label>{t('finances.endDate')} <span className="text-zinc-400">({t('common.optional')})</span></Label>
                <Input type="date" value={modal.end_date} onChange={e => setModal({ ...modal, end_date: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Switch checked={modal.expect_receipt} onChange={v => setModal({ ...modal, expect_receipt: v })} /> {t('finances.expectReceipt')}
            </label>
            <p className="-mt-2 pl-11 text-xs text-zinc-400">{t('finances.expectReceiptHint')}</p>
            {modal.expect_receipt && (
              <div>
                <Label>{t('finances.matchMerchant')} <span className="text-zinc-400">({t('common.optional')})</span></Label>
                <Input value={modal.match_merchant} onChange={e => setModal({ ...modal, match_merchant: e.target.value })} placeholder={t('finances.matchMerchantPlaceholder')} />
                <p className="mt-1 text-xs text-zinc-400">{t('finances.matchMerchantHint')}</p>
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Switch checked={modal.is_transfer} onChange={v => setModal({ ...modal, is_transfer: v, counterpart_id: v ? modal.counterpart_id : null })} /> {t('finances.transferLabel')}
            </label>
            <p className="-mt-2 pl-11 text-xs text-zinc-400">{t('finances.transferHint')}</p>
            {modal.is_transfer && <CounterpartField draft={modal} setDraft={setModal} costs={costs ?? []} scopeKonten={scopeKonten} />}
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Switch checked={modal.active} onChange={v => setModal({ ...modal, active: v })} /> {t('finances.activeLabel')}
            </label>
            <div className="mt-1 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setModal(null)}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={!modal.label.trim() || !modal.monthly_eur || !modal.konto_id || save.isPending}>{t('common.save')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
