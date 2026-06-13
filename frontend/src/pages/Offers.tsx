import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ExternalLink, RefreshCw, ChevronDown, EyeOff, Eye } from 'lucide-react';
import { api } from '../api/client';
import { Card, Spinner, EmptyState, Badge, Button } from '../components/ui';
import { CanonicalIcon } from '../components/IconPicker';
import { useAuth } from '../context/auth';
import { toast } from '../components/Toast';
import { FirstVisitHint } from '../components/FirstVisitHint';
import { cn, fmtDate } from '../lib/utils';

interface Offer {
  id: number; canonical_name: string; store: string | null; price: string | null;
  old_price: string | null; valid_until: string | null; source_url: string | null;
  confidence: number | null; found_at: string;
  brand: string | null; image_url: string | null; unit: string | null; source: string | null;
  good_price: boolean; discount_pct: number | null;
}
interface PantryInfo {
  avg_paid: number | null; last_bought: string | null;
  interval_days: number | null; due_in_days: number | null;
  status: 'overdue' | 'soon' | 'ok' | null;
}
interface OffersResponse { offers: Offer[]; pantry: Record<string, PantryInfo> }

const priceNum = (s: string | null): number | null => {
  if (!s) return null;
  const n = parseFloat(s.replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
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
  const title = p.interval_days != null ? t('offers.rhythm', { days: p.interval_days }) : '';
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
          {o.price && <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-500">{o.price}{o.unit ? `/${o.unit}` : ''}</span>}
          {o.old_price && <span className="text-xs text-zinc-400 line-through">{o.old_price}</span>}
          {o.good_price && <GoodPrice pct={o.discount_pct} t={t} />}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-400">
          {o.valid_until && <span>{t('offers.until')} {o.valid_until}</span>}
          <span>· {fmtDate(o.found_at, lang)}</span>
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

export function Offers() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const { user } = useAuth();
  const canWrite = user?.can_write !== false;
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [showHidden, setShowHidden] = useState(false);

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
      for (let i = 0; i < 40; i++) {
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

  // chain filter → group by canonical → sort (due first, then name).
  const groups = useMemo(() => {
    const m = new Map<string, Offer[]>();
    for (const o of offers) {
      if (chain && o.store !== chain) continue;
      const arr = m.get(o.canonical_name) ?? [];
      arr.push(o); m.set(o.canonical_name, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => (priceNum(a.price) ?? 1e9) - (priceNum(b.price) ?? 1e9));
    const rank = (s?: string | null) => (s === 'overdue' ? 0 : s === 'soon' ? 1 : 2);
    return [...m.entries()].sort((a, b) =>
      rank(pantry[a[0]]?.status) - rank(pantry[b[0]]?.status) || a[0].localeCompare(b[0], lang));
  }, [offers, chain, pantry, lang]);

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

      {/* Kette (chain) picker */}
      {chains.length > 1 && (
        <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1">
          <button
            onClick={() => setChain(null)}
            className={cn('shrink-0 rounded-full border px-3 py-1 text-xs font-medium',
              chain === null ? 'border-transparent bg-violet-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}
          >
            {t('offers.allKetten')}
          </button>
          {chains.map(c => (
            <button
              key={c}
              onClick={() => setChain(chain === c ? null : c)}
              className={cn('shrink-0 rounded-full border px-3 py-1 text-xs font-medium',
                chain === c ? 'border-transparent bg-violet-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}
            >
              {c}
            </button>
          ))}
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
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-400">
                    {best?.price && (
                      <span className="font-semibold text-emerald-600 dark:text-emerald-500">
                        {t('offers.from')} {best.price}{best.unit ? `/${best.unit}` : ''}
                      </span>
                    )}
                    {stores.size > 0 && <span>@ {[...stores].slice(0, 2).join(', ')}{stores.size > 2 ? ` +${stores.size - 2}` : ''}</span>}
                    {p?.status === 'overdue' && p.interval_days != null && <span className="text-red-500">{t('offers.rhythm', { days: p.interval_days })}</span>}
                  </div>
                </button>
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
