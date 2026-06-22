import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ExternalLink, RefreshCw, ChevronDown, ChevronLeft, ChevronRight, EyeOff, Eye, Pin, ListPlus, Check, X, Search, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { Card, Spinner, EmptyState, Badge, Button, Input } from '../components/ui';
import { CanonicalIcon } from '../components/IconPicker';
import { useAuth } from '../context/auth';
import { toast } from '../components/Toast';
import { FirstVisitHint } from '../components/FirstVisitHint';
import { cn, fmtDate, eur } from '../lib/utils';

interface Offer {
  id: number; canonical_name: string; store: string | null; price: string | null;
  old_price: string | null; valid_until: string | null;
  valid_from: string | null; valid_to: string | null; source_url: string | null;
  confidence: number | null; found_at: string;
  brand: string | null; image_url: string | null; unit: string | null; source: string | null; chain_slug: string | null;
  good_price: boolean; discount_pct: number | null;
  ref_price: string | null; grundpreis: number | null; grundpreis_unit: string | null;
  compare_unit: string | null; avg_compare: number | null;
}
interface PantryInfo {
  avg_paid: number | null; last_bought: string | null;
  interval_days: number | null; due_in_days: number | null;
  status: 'overdue' | 'soon' | 'ok' | null; typ_qty: number | null;
  weekly_consumption: number | null; consumption_unit: string | null;
}
interface NearestBranch { branch_id: number; name: string; address: string | null; distance_km: number }
interface OffersResponse { offers: Offer[]; pantry: Record<string, PantryInfo>; chains?: Record<string, NearestBranch> }

const priceNum = (s: string | null): number | null => {
  if (!s) return null;
  const n = parseFloat(s.replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** Short "day.month" for compact offer-validity ranges (no year). */
const fmtDay = (iso: string | null, lang: string): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(lang, { day: '2-digit', month: '2-digit' }).format(d);
};

const HIDDEN_KEY = 'vds.offers.hidden';
const loadHidden = (): Set<string> => {
  try { return new Set<string>(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')); } catch { return new Set(); }
};

/** Coloured "due to buy" pill from the household's buy rhythm. */
function DueBadge({ p, t }: { p?: PantryInfo; t: TFunction }) {
  if (!p || (p.status !== 'overdue' && p.status !== 'soon')) return null;
  const tone = p.status === 'overdue'
    ? 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
    : 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300';
  const title = [
    p.weekly_consumption != null && p.consumption_unit
      ? t('offers.weekly', { n: String(p.weekly_consumption).replace('.', ','), unit: p.consumption_unit }) : '',
    p.interval_days != null ? t('offers.rhythm', { days: p.interval_days }) : '',
  ].filter(Boolean).join(' · ');
  return (
    <span title={title} className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold', tone)}>
      {p.status === 'overdue' ? t('offers.dueOverdue') : t('offers.dueSoon')}
    </span>
  );
}

function GoodPrice({ pct, t }: { pct: number | null; t: TFunction }) {
  return (
    <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
      {t('offers.goodPrice')}{pct ? ` −${pct}%` : ''}
    </span>
  );
}

function OfferRow({ o, isHidden, onHide, t, lang }: {
  o: Offer; isHidden: boolean; onHide: () => void; t: TFunction; lang: string;
}) {
  // Validity window: prefer the structured valid_from/valid_to dates; fall back
  // to Marktguru's free-text valid_until (already a range → no "bis" prefix).
  const vFrom = fmtDay(o.valid_from, lang);
  const vTo = fmtDay(o.valid_to, lang);
  const validity = vFrom && vTo ? `${t('offers.valid')} ${vFrom}–${vTo}`
    : vTo ? `${t('offers.until')} ${vTo}`
    : vFrom ? `${t('offers.from')} ${vFrom}`
    : o.valid_until ? (/[-–]/.test(o.valid_until) ? `${t('offers.valid')} ${o.valid_until.trim()}` : `${t('offers.until')} ${o.valid_until.trim()}`)
    : null;
  return (
    <div className={cn('flex items-center gap-2.5 px-3 py-2', isHidden && 'opacity-40')}>
      {o.image_url
        ? <img src={o.image_url} alt="" loading="lazy" className="h-9 w-9 shrink-0 rounded-md object-contain"
               onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
        : <span className="h-9 w-9 shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-sm font-medium">{o.store ?? '?'}</span>
          {o.brand && <span className="text-xs text-zinc-400">{o.brand}</span>}
          {o.price && <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-500">{o.price}</span>}
          {o.grundpreis != null && o.grundpreis_unit && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">({o.grundpreis.toFixed(2).replace('.', ',')} €/{o.grundpreis_unit})</span>
          )}
          {o.old_price && <span className="text-xs text-zinc-400 line-through">{o.old_price}</span>}
          {o.good_price && <GoodPrice pct={o.discount_pct} t={t} />}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
          {validity && <span className="font-medium text-zinc-500 dark:text-zinc-400">{validity}</span>}
          <span title={t('offers.asOfHint')}>· {t('offers.asOf')} {fmtDate(o.found_at, lang)}</span>
        </div>
      </div>
      {o.source_url && (
        <a href={o.source_url} target="_blank" rel="noopener noreferrer"
           className="shrink-0 rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30" title={t('offers.source')}>
          <ExternalLink size={14} />
        </a>
      )}
      <button onClick={onHide} title={isHidden ? t('offers.unhide') : t('offers.hide')}
              className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
        {isHidden ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
    </div>
  );
}

// ---- Recommendation engine (client-side over /api/offers/mine) --------------
// "What should I buy where this week?" = the user's offers that are due to
// re-buy AND/OR a good price, ranked, then rolled up per chain. Pure
// presentation over data the page already has — no extra request.
const DAY_MS = 86_400_000;
const dms = (iso: string | null): number => (iso ? Date.parse(iso) : NaN);

interface RecPick {
  canonical: string; offer: Offer; status: 'overdue' | 'soon' | 'ok' | null;
  savings: number | null; expiringSoon: boolean; startsFuture: boolean; score: number;
}
interface ChainRec {
  store: string; chain_slug: string | null; picks: RecPick[]; dueCount: number; goodCount: number;
  savings: number; soonestValidTo: string | null; score: number;
}

function buildRecommendations(offers: Offer[], pantry: Record<string, PantryInfo>, pinned: Set<string>, nowMs: number) {
  const SOON = 3 * DAY_MS;
  const cmp = (x: Offer) => x.grundpreis ?? priceNum(x.price) ?? 1e9;
  // cheapest still-valid offer per product+store
  const best = new Map<string, Offer>();
  for (const o of offers) {
    if (!o.store) continue;
    const vt = dms(o.valid_to);
    if (Number.isFinite(vt) && vt < nowMs - DAY_MS) continue; // already expired
    const key = `${o.canonical_name}@@${o.store}`;
    const cur = best.get(key);
    if (!cur || cmp(o) < cmp(cur)) best.set(key, o);
  }
  const picks: RecPick[] = [];
  for (const o of best.values()) {
    const p = pantry[o.canonical_name];
    const status = p?.status ?? null;
    const due = status === 'overdue' || status === 'soon';
    if (!due && !o.good_price) continue; // recommend only due and/or good-price
    const savings = (o.avg_compare != null && o.grundpreis != null && p?.typ_qty != null && o.avg_compare > o.grundpreis)
      ? Math.round((o.avg_compare - o.grundpreis) * p.typ_qty * 100) / 100 : null;
    const vt = dms(o.valid_to), vf = dms(o.valid_from);
    const expiringSoon = Number.isFinite(vt) && vt >= nowMs && vt - nowMs <= SOON;
    const startsFuture = Number.isFinite(vf) && vf > nowMs;
    let score = 0;
    if (status === 'overdue') score += 4; else if (status === 'soon') score += 2;
    if (o.good_price) score += 2 + (o.discount_pct ?? 0) / 50;
    if (expiringSoon) score += 1;
    if (o.store && pinned.has(o.store)) score += 0.5;
    if (startsFuture) score -= 1; // not actionable yet → rank lower
    picks.push({ canonical: o.canonical_name, offer: o, status, savings, expiringSoon, startsFuture, score });
  }
  picks.sort((a, b) => b.score - a.score);

  const chainMap = new Map<string, ChainRec>();
  for (const pk of picks) {
    const store = pk.offer.store as string;
    let cr = chainMap.get(store);
    if (!cr) { cr = { store, chain_slug: pk.offer.chain_slug, picks: [], dueCount: 0, goodCount: 0, savings: 0, soonestValidTo: null, score: 0 }; chainMap.set(store, cr); }
    cr.picks.push(pk);
    if (pk.status === 'overdue' || pk.status === 'soon') cr.dueCount++;
    if (pk.offer.good_price) cr.goodCount++;
    if (pk.savings) cr.savings += pk.savings;
    const vt = pk.offer.valid_to;
    if (vt && !pk.startsFuture && (!cr.soonestValidTo || vt < cr.soonestValidTo)) cr.soonestValidTo = vt;
  }
  const chains = [...chainMap.values()];
  for (const cr of chains) cr.score = cr.dueCount * 2 + cr.goodCount + cr.savings / 5 + (pinned.has(cr.store) ? 1 : 0);
  chains.sort((a, b) => b.score - a.score);
  return { picks, chains };
}

function RecPickRow({ pk, onList, toggleList, canWrite, t, lang }: {
  pk: RecPick; onList: Set<string>; toggleList: (c: string) => void; canWrite: boolean; t: TFunction; lang: string;
}) {
  const o = pk.offer;
  const vFrom = fmtDay(o.valid_from, lang), vTo = fmtDay(o.valid_to, lang);
  const validity = pk.startsFuture && vFrom ? `${t('offers.from')} ${vFrom}`
    : pk.expiringSoon && vTo ? t('offers.recExpiring', { date: vTo })
    : vTo ? `${t('offers.until')} ${vTo}` : null;
  return (
    <div className="flex items-center gap-2 py-1.5">
      <CanonicalIcon name={pk.canonical} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="truncate text-sm font-medium">{pk.canonical}</span>
          <span className="text-xs text-zinc-400">@ {o.store}</span>
          {o.grundpreis != null && o.grundpreis_unit && (
            <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-500">
              {o.grundpreis.toFixed(2).replace('.', ',')} €/{o.grundpreis_unit}
            </span>
          )}
          {pk.status === 'overdue' && (
            <span className="shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-950/60 dark:text-red-300">{t('offers.dueOverdue')}</span>
          )}
          {pk.status === 'soon' && (
            <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">{t('offers.dueSoon')}</span>
          )}
          {o.good_price && (
            <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
              {t('offers.goodPrice')}{o.discount_pct ? ` −${o.discount_pct}%` : ''}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
          {validity && <span className={cn(pk.expiringSoon && 'font-semibold text-red-500 dark:text-red-400')}>{validity}</span>}
          {pk.savings != null && pk.savings > 0 && <span>· {t('offers.recSave', { amount: eur(pk.savings) })}</span>}
        </div>
      </div>
      {canWrite && (
        <button onClick={() => toggleList(pk.canonical)} title={onList.has(pk.canonical) ? t('offers.onList') : t('offers.addToList')}
          className={cn('shrink-0 rounded-lg p-1.5', onList.has(pk.canonical)
            ? 'text-emerald-600 hover:bg-emerald-50 dark:text-emerald-500 dark:hover:bg-emerald-950/30'
            : 'text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30')}>
          {onList.has(pk.canonical) ? <Check size={15} /> : <ListPlus size={15} />}
        </button>
      )}
    </div>
  );
}

function RecommendationSection({ offers, pantry, pinned, chains, onList, toggleList, canWrite, t, lang }: {
  offers: Offer[]; pantry: Record<string, PantryInfo>; pinned: Set<string>;
  chains?: Record<string, NearestBranch>;
  onList: Set<string>; toggleList: (c: string) => void; canWrite: boolean; t: TFunction; lang: string;
}) {
  const rec = useMemo(() => buildRecommendations(offers, pantry, pinned, Date.now()), [offers, pantry, pinned]);
  if (!rec.picks.length) return null;
  const topChain = rec.chains[0];
  const nb = topChain?.chain_slug ? chains?.[topChain.chain_slug] : undefined;
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/20">
      <div className="flex items-center gap-2">
        <Sparkles size={16} className="text-emerald-600 dark:text-emerald-400" />
        <h2 className="text-sm font-bold">{t('offers.recTitle')}</h2>
      </div>
      {topChain && (topChain.dueCount + topChain.goodCount) > 0 && (
        <div className="text-xs text-zinc-600 dark:text-zinc-300">
          <span className="font-semibold">{t('offers.recBestStore')}: {topChain.store}</span>
          {' — '}{t('offers.recBestStoreSummary', { count: topChain.picks.length })}
          {topChain.savings > 0 && <> · {t('offers.recSaveAbout', { amount: eur(topChain.savings) })}</>}
          {topChain.soonestValidTo && <> · {t('offers.until')} {fmtDay(topChain.soonestValidTo, lang)}</>}
          {nb && <> · {t('offers.nearestBranch', { name: nb.name, km: nb.distance_km.toFixed(1).replace('.', ',') })}</>}
        </div>
      )}
      <div className="flex flex-col divide-y divide-emerald-100 dark:divide-emerald-900/40">
        {rec.picks.slice(0, 6).map(pk => (
          <RecPickRow key={pk.offer.id} pk={pk} onList={onList} toggleList={toggleList} canWrite={canWrite} t={t} lang={lang} />
        ))}
      </div>
    </div>
  );
}

export function Offers() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const { user } = useAuth();
  const canWrite = user?.can_write !== false;
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState<string | null>(null);   // specific chain filter
  const [pinnedView, setPinnedView] = useState(false);        // "Deine Läden"
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [showHidden, setShowHidden] = useState(false);

  // Pinned chains ("Deine Läden") — persisted per user via PATCH /api/me.
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(user?.pinned_chains ?? []));
  useEffect(() => { setPinned(new Set(user?.pinned_chains ?? [])); }, [user?.pinned_chains]);
  const togglePin = (c: string) => {
    const next = new Set(pinned);
    next.has(c) ? next.delete(c) : next.add(c);
    setPinned(next);
    api('/api/me', { method: 'PATCH', body: { pinned_chains: [...next] } }).catch(() => {});
  };

  const { data: shopList } = useQuery({
    queryKey: ['shopping-list-mini'],
    queryFn: () => api<{ canonical_name: string }[]>('/api/shopping-list'),
    staleTime: 30_000,
  });
  const onList = useMemo(() => new Set((shopList ?? []).map(r => r.canonical_name)), [shopList]);

  // Ad-hoc "watch" products (things not in the artikel list, e.g. Ben & Jerry's).
  const [watchInput, setWatchInput] = useState('');
  const { data: watches } = useQuery({
    queryKey: ['offers-watches'],
    queryFn: () => api<string[]>('/api/offers/watches'),
    staleTime: 60_000,
  });
  const addWatch = async () => {
    const name = watchInput.trim();
    if (!name) return;
    try {
      await api('/api/offers/watches', { method: 'POST', body: { name } });
      setWatchInput('');
      await qc.invalidateQueries({ queryKey: ['offers-watches'] });
      toast(t('offers.watchAdded', { name }), 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const removeWatch = async (name: string) => {
    try {
      await api('/api/offers/watches', { method: 'DELETE', body: { name } });
      await qc.invalidateQueries({ queryKey: ['offers-watches'] });
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const toggleList = async (c: string) => {
    const adding = !onList.has(c);
    try {
      if (adding) await api('/api/shopping-list', { method: 'POST', body: { canonical_name: c } });
      else await api('/api/shopping-list/feedback', { method: 'POST', body: { action: 'done', canonical_name: c } });
      await qc.invalidateQueries({ queryKey: ['shopping-list-mini'] });
      toast(adding ? t('offers.addedToList', { name: c }) : t('offers.removedFromList', { name: c }), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // horizontal chip scroll arrows (mirrors the receipts overview)
  const chipsRef = useRef<HTMLDivElement>(null);
  const [chipScroll, setChipScroll] = useState({ left: false, right: false });
  const updateChipScroll = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    setChipScroll({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  const scrollChips = (dir: -1 | 1) => chipsRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' });

  const { data, isLoading } = useQuery({
    queryKey: ['offers-mine'],
    queryFn: () => api<OffersResponse>('/api/offers/mine'),
  });
  const offers = data?.offers ?? [];
  const pantry = data?.pantry ?? {};

  const persistHidden = (next: Set<string>) => {
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
    setHidden(next);
  };
  const toggleHidden = (key: string) => {
    const next = new Set(hidden);
    next.has(key) ? next.delete(key) : next.add(key);
    persistHidden(next);
  };
  const toggleExpand = (c: string) => setExpanded(prev => {
    const n = new Set(prev); n.has(c) ? n.delete(c) : n.add(c); return n;
  });

  const refresh = async () => {
    setBusy(true);
    try {
      await api('/api/offers/refresh', { method: 'POST' });
      // Poll the (now DB-backed, cross-replica) status until the search finishes.
      // Give the run a moment to register before the first check.
      await new Promise(r => setTimeout(r, 1500));
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s = await api<{ running: boolean }>('/api/offers/status');
        if (!s.running) break;
      }
      persistHidden(new Set());       // a fresh fetch un-hides everything
      await qc.invalidateQueries({ queryKey: ['offers-mine'] });
      toast(t('offers.refreshDone'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  // Kette picker: distinct chains present in the offers.
  const chains = useMemo(() => {
    const set = new Set<string>();
    for (const o of offers) if (o.store) set.add(o.store);
    return [...set].sort((a, b) => a.localeCompare(b, lang));
  }, [offers, lang]);

  // re-evaluate the scroll arrows when the chip row renders / resizes
  useEffect(() => {
    updateChipScroll();
    const el = chipsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateChipScroll);
    ro.observe(el);
    return () => ro.disconnect();
  }, [chains, pinned, updateChipScroll]);

  // chain / "Deine Läden" filter → group by canonical → sort (due first, then name).
  const groups = useMemo(() => {
    const m = new Map<string, Offer[]>();
    for (const o of offers) {
      if (pinnedView) { if (!o.store || !pinned.has(o.store)) continue; }
      else if (chain && o.store !== chain) continue;
      const arr = m.get(o.canonical_name) ?? [];
      arr.push(o); m.set(o.canonical_name, arr);
    }
    // Sort by the real comparison price (Grundpreis €/kg), not the teaser price.
    const cmp = (o: Offer) => o.grundpreis ?? priceNum(o.price) ?? 1e9;
    for (const arr of m.values()) arr.sort((a, b) => cmp(a) - cmp(b));
    const rank = (s?: string | null) => (s === 'overdue' ? 0 : s === 'soon' ? 1 : 2);
    return [...m.entries()].sort((a, b) =>
      rank(pantry[a[0]]?.status) - rank(pantry[b[0]]?.status) || a[0].localeCompare(b[0], lang));
  }, [offers, chain, pinnedView, pinned, pantry, lang]);

  const groupVisibleOffers = (arr: Offer[]) => arr.filter(o => showHidden || !hidden.has(`o:${o.id}`));
  const groupHidden = (c: string, arr: Offer[]) =>
    hidden.has(`c:${c}`) || arr.every(o => hidden.has(`o:${o.id}`));

  const shownGroups = groups.filter(([c, arr]) => showHidden || !groupHidden(c, arr));
  const hiddenCount = groups.filter(([c, arr]) => groupHidden(c, arr)).length;

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-bold">{t('offers.title')}</h1>
        {canWrite && (
          <Button variant="secondary" onClick={refresh} disabled={busy} className="shrink-0">
            <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />
            {busy ? t('offers.refreshing') : t('offers.refresh')}
          </Button>
        )}
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('offers.hint')}</p>
      <FirstVisitHint id="offers" titleKey="hint.offers.title" bodyKey="hint.offers.body" />
      {busy && <p className="text-xs text-emerald-600 dark:text-emerald-500">{t('offers.refreshingHint')}</p>}

      {!isLoading && (
        <RecommendationSection offers={offers} pantry={pantry} pinned={pinned} chains={data?.chains} onList={onList} toggleList={toggleList} canWrite={canWrite} t={t} lang={lang} />
      )}

      {/* Watch arbitrary products that aren't in your artikel list */}
      {canWrite && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-200 p-2.5 dark:border-zinc-800">
          <form onSubmit={e => { e.preventDefault(); void addWatch(); }} className="flex gap-2">
            <div className="relative flex-1">
              <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
              <Input value={watchInput} onChange={e => setWatchInput(e.target.value)} placeholder={t('offers.watchPlaceholder')} className="pl-8" />
            </div>
            <Button type="submit" variant="secondary" disabled={!watchInput.trim()}>{t('common.add')}</Button>
          </form>
          {watches && watches.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-zinc-400">{t('offers.watchLabel')}</span>
              {watches.map(w => (
                <span key={w} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800">
                  {w}
                  <button onClick={() => void removeWatch(w)} className="text-zinc-400 hover:text-red-500" aria-label={t('common.delete')}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Kette (chain) picker with scroll arrows, "Deine Läden", and pin toggles */}
      {chains.length > 1 && (
        <div className="relative">
          {chipScroll.left && (
            <button onClick={() => scrollChips(-1)} title={t('common.scrollLeft')}
              className="absolute left-0 top-1/2 z-10 hidden -translate-y-1/2 rounded-full border border-zinc-200 bg-white/90 p-1 shadow-sm backdrop-blur hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900/90 dark:hover:bg-zinc-800 sm:block">
              <ChevronLeft size={16} />
            </button>
          )}
          <div ref={chipsRef} onScroll={updateChipScroll} className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1">
            <button
              onClick={() => { setChain(null); setPinnedView(false); }}
              className={cn('shrink-0 rounded-full border px-3 py-1 text-xs font-medium',
                chain === null && !pinnedView ? 'border-transparent bg-violet-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}
            >
              {t('offers.allKetten')}
            </button>
            {pinned.size > 0 && (
              <button
                onClick={() => { setPinnedView(true); setChain(null); }}
                className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium',
                  pinnedView ? 'border-transparent bg-violet-600 text-white' : 'border-violet-300 text-violet-600 dark:border-violet-800 dark:text-violet-300')}
              >
                <Pin size={12} fill="currentColor" /> {t('offers.deineLaeden')}
              </button>
            )}
            {chains.map(c => {
              const active = chain === c && !pinnedView;
              const isPinned = pinned.has(c);
              return (
                <div key={c}
                  className={cn('inline-flex shrink-0 items-center rounded-full border text-xs font-medium',
                    active ? 'border-transparent bg-violet-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>
                  <button onClick={() => { setChain(active ? null : c); setPinnedView(false); }} className="py-1 pl-3 pr-1">{c}</button>
                  <button
                    onClick={() => togglePin(c)}
                    title={isPinned ? t('offers.unpin') : t('offers.pin')}
                    className={cn('py-1 pl-0.5 pr-2', active ? 'text-white/80 hover:text-white' : isPinned ? 'text-violet-500' : 'text-zinc-300 hover:text-violet-500 dark:text-zinc-600')}
                  >
                    <Pin size={12} fill={isPinned ? 'currentColor' : 'none'} />
                  </button>
                </div>
              );
            })}
          </div>
          {chipScroll.right && (
            <button onClick={() => scrollChips(1)} title={t('common.scrollRight')}
              className="absolute right-0 top-1/2 z-10 hidden -translate-y-1/2 rounded-full border border-zinc-200 bg-white/90 p-1 shadow-sm backdrop-blur hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900/90 dark:hover:bg-zinc-800 sm:block">
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      )}

      {isLoading && <Spinner />}
      {!isLoading && !shownGroups.length && <EmptyState>{t('offers.empty')}</EmptyState>}

      <div className="flex flex-col gap-2">
        {shownGroups.map(([c, arr]) => {
          const shown = groupVisibleOffers(arr);
          const p = pantry[c];
          const best = shown[0] ?? arr[0];
          const anyGood = shown.some(o => o.good_price);
          const bestPct = Math.max(0, ...shown.filter(o => o.good_price).map(o => o.discount_pct ?? 0));
          const isExp = expanded.has(c);
          const ghidden = groupHidden(c, arr);
          const stores = new Set(arr.map(o => o.store).filter(Boolean));
          return (
            <Card key={c} className={cn('overflow-hidden p-0', ghidden && 'opacity-50')}>
              <div className="flex items-center gap-3 p-3">
                <CanonicalIcon name={c} size={36} />
                <button onClick={() => toggleExpand(c)} className="min-w-0 flex-1 text-left">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{c}</span>
                    <Badge>{arr.length}</Badge>
                    <DueBadge p={p} t={t} />
                    {anyGood && <GoodPrice pct={bestPct || null} t={t} />}
                    {onList.has(c) && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                        <Check size={10} /> {t('offers.onListShort')}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
                    {best?.price && (
                      <span className="font-semibold text-emerald-600 dark:text-emerald-500">
                        {t('offers.from')} {best.grundpreis != null && best.grundpreis_unit
                          ? `${best.grundpreis.toFixed(2).replace('.', ',')} €/${best.grundpreis_unit}`
                          : best.price}
                      </span>
                    )}
                    {stores.size > 0 && <span>@ {[...stores].slice(0, 2).join(', ')}{stores.size > 2 ? ` +${stores.size - 2}` : ''}</span>}
                    {p?.status === 'overdue' && p.interval_days != null && <span className="text-red-500">{t('offers.rhythm', { days: p.interval_days })}</span>}
                  </div>
                </button>
                {canWrite && (
                  <button onClick={() => toggleList(c)} title={onList.has(c) ? t('offers.onList') : t('offers.addToList')}
                          className={cn('shrink-0 rounded-lg p-1.5',
                            onList.has(c) ? 'text-emerald-600 hover:bg-emerald-50 dark:text-emerald-500 dark:hover:bg-emerald-950/30'
                              : 'text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30')}>
                    {onList.has(c) ? <Check size={16} /> : <ListPlus size={16} />}
                  </button>
                )}
                <button onClick={() => toggleHidden(`c:${c}`)} title={ghidden ? t('offers.unhide') : t('offers.hide')}
                        className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  {ghidden ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
                <button onClick={() => toggleExpand(c)} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <ChevronDown className={cn('h-4 w-4 transition-transform', isExp && 'rotate-180')} />
                </button>
              </div>
              {isExp && (
                <div className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
                  {(showHidden ? arr : shown).map(o => (
                    <OfferRow key={o.id} o={o} isHidden={hidden.has(`o:${o.id}`)} onHide={() => toggleHidden(`o:${o.id}`)} t={t} lang={lang} />
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {hiddenCount > 0 && (
        <button onClick={() => setShowHidden(v => !v)} className="self-start text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          {showHidden ? t('offers.hideHidden') : t('offers.hiddenCount', { count: hiddenCount })}
        </button>
      )}

      {!!offers.length && <p className="text-[11px] text-zinc-400">{t('offers.disclaimer')}</p>}
    </div>
  );
}
