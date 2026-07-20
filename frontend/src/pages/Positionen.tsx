import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, X, Lock, Store as StoreIcn, SlidersHorizontal } from 'lucide-react';
import { api } from '../api/client';
import type { Position } from '../api/types';
import { Card, Input, Select, Spinner, Label } from '../components/ui';
import { cn, eur, fmtDate } from '../lib/utils';

interface StoreRow { key: string; display: string; receipts: number }

const PAGE = 50;

/** Flat list of every line item ("Position") with search/filter/sort. Distinct
 *  from receipts (Belege) and canonical products (Artikel). ALL filter state lives
 *  in the URL, so entering a receipt and pressing Back restores this exact view. */
export function Positionen() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const q = params.get('q') ?? '';
  const store = params.get('store') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const uncat = params.get('uncat') ?? '';   // '1' → only lines the AI never categorised (deep-link from Finanzen "Kategorie fehlt")
  const sort = params.get('sort') ?? 'date_desc';
  const [filterOpen, setFilterOpen] = useState(false);
  const filtersActive = !!(store || from || to || uncat || (sort && sort !== 'date_desc'));

  const setParam = useCallback((key: string, val: string | null) => {
    const next = new URLSearchParams(params);
    if (val) next.set(key, val); else next.delete(key);
    setParams(next, { replace: true });
  }, [params, setParams]);

  // The filter slice that drives the API (everything except paging).
  const apiQs = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (store) p.set('store', store);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (uncat) p.set('uncat', uncat);
    p.set('sort', sort);
    return p.toString();
  }, [q, store, from, to, uncat, sort]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['positionen', apiQs],
    queryFn: ({ pageParam }) => api<Position[]>(`/api/positionen?${apiQs}&limit=${PAGE}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length * PAGE : undefined),
  });
  const positionen = useMemo(() => (data?.pages ?? []).flat(), [data]);

  // Store chips (chains); an incoming ?store= from a shop is a full branch name →
  // shown as its own active chip even when it isn't one of the chain keys.
  const { data: stores } = useQuery({
    queryKey: ['stores-min'],
    queryFn: () => api<StoreRow[]>('/api/stores?shops=1'),
    staleTime: 60_000,
  });
  const chips = useMemo(() => {
    const list = (stores ?? []).map(s => ({ key: s.key, label: s.display }));
    if (store && !list.some(c => c.key === store)) list.unshift({ key: store, label: store });
    return list;
  }, [stores, store]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(es => {
      if (es[0].isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="flex flex-col gap-3">
      {/* Search + Filter toggle on one row (same look as Artikel/Belege); the
          toggle reveals sort, date range and stores. */}
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input
            className="pl-9 pr-9"
            placeholder={t('positionen.search')}
            title={t('common.searchOps')}
            value={q}
            onChange={e => setParam('q', e.target.value)}
          />
          {q && (
            <button onClick={() => setParam('q', null)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" title={t('common.clear')}>
              <X size={15} />
            </button>
          )}
        </div>
        <button
          onClick={() => setFilterOpen(o => !o)}
          className={cn('flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium',
            filtersActive ? 'border-emerald-400 text-emerald-600' : 'border-zinc-200 text-zinc-500 dark:border-zinc-800')}
        >
          <SlidersHorizontal size={15} /> {t('artikel.filters')}
          {filtersActive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
        </button>
      </div>

      {filterOpen && (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div>
            <Label>{t('artikel.filterSort')}</Label>
            <Select value={sort} onChange={e => setParam('sort', e.target.value)}>
              <option value="date_desc">{t('positionen.sort_date_desc')}</option>
              <option value="date_asc">{t('positionen.sort_date_asc')}</option>
              <option value="price_desc">{t('positionen.sort_price_desc')}</option>
              <option value="price_asc">{t('positionen.sort_price_asc')}</option>
              <option value="name_asc">{t('positionen.sort_name_asc')}</option>
            </Select>
          </div>

          <div>
            <Label>{t('positionen.dateRange')}</Label>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Input type="date" value={from} onChange={e => setParam('from', e.target.value || null)} className="w-auto" />
              <span className="text-zinc-400">–</span>
              <Input type="date" value={to} onChange={e => setParam('to', e.target.value || null)} className="w-auto" />
              {(from || to) && (
                <button onClick={() => { const next = new URLSearchParams(params); next.delete('from'); next.delete('to'); setParams(next, { replace: true }); }} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" title={t('common.clear')}>
                  <X size={15} />
                </button>
              )}
            </div>
          </div>

          {chips.length > 0 && (
            <div>
              <Label>{t('positionen.stores')}</Label>
              <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1">
                <button
                  onClick={() => setParam('store', null)}
                  className={cn('shrink-0 rounded-full border px-3 py-1 text-xs font-medium', !store ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}
                >
                  {t('positionen.allStores')}
                </button>
                {chips.map(c => (
                  <button
                    key={c.key}
                    onClick={() => setParam('store', store === c.key ? null : c.key)}
                    className={cn('shrink-0 truncate rounded-full border px-3 py-1 text-xs font-medium', store === c.key ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <Spinner className="py-10" />
      ) : positionen.length === 0 ? (
        <div className="py-10 text-center text-sm text-zinc-400">{t('positionen.empty')}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {positionen.map(p => (
            <Card key={p.id} onClick={() => navigate(`/receipts/${p.einkauf_id}?highlight=${p.id}`)} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{p.canonical_name || p.name}</div>
                {p.canonical_name && p.name && p.name !== p.canonical_name && (
                  <div className="truncate text-xs text-zinc-400">{p.name}</div>
                )}
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
                  <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
                    <StoreIcn size={11} className="shrink-0 text-zinc-400" />
                    <span className="truncate">{p.roh_ladenname ?? '—'}</span>
                  </span>
                  <span className="shrink-0">·</span>
                  <span className="shrink-0">{fmtDate(p.datum, i18n.language)}</span>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="tabular font-semibold text-emerald-600 dark:text-emerald-500">{eur(p.preis)}</div>
                {(p.menge != null || p.einheit) && (
                  <div className="text-[11px] text-zinc-400">
                    {[p.menge != null ? Number(p.menge).toLocaleString(i18n.language, { maximumFractionDigits: 3 }) : null, p.einheit].filter(Boolean).join(' ')}
                  </div>
                )}
              </div>
              {p.private && <Lock size={14} className="shrink-0 text-rose-500" />}
            </Card>
          ))}
          <div ref={sentinelRef} className="h-1" />
          {isFetchingNextPage && <Spinner className="py-4" />}
        </div>
      )}
    </div>
  );
}
