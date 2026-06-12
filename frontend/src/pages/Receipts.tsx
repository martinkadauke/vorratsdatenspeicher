import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, CheckCircle2, Rows3, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import type { Receipt } from '../api/types';
import { Card, Input, Spinner, EmptyState } from '../components/ui';
import { StoreIcon } from '../components/IconPicker';
import { cn, eur, fmtDate, monthLabel } from '../lib/utils';

interface Store { key: string; display: string; receipts: number; total: number; raw: string[] }

const PAGE = 30;

// Card-size presets: min column width (px) + thumbnail size (px).
// The last preset forces a single column (huge min width) → scrubber on.
const SIZES = [
  { min: 190, thumb: 44 },
  { min: 250, thumb: 60 },
  { min: 340, thumb: 80 },
  { min: 480, thumb: 104 },
  { min: 99999, thumb: 150 },
];
const SIZE_KEY = 'vds.receiptCardSize';

const monthKeyOf = (datum: string) => (datum ?? '').slice(0, 7); // "YYYY-MM"

export function Receipts() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [storeFilter, setStoreFilter] = useState<string | null>(params.get('store'));
  const [kontoFilter, setKontoFilter] = useState<string | null>(params.get('konto'));

  const { data: kontenRaw } = useQuery({
    queryKey: ['konten'],
    queryFn: () => api<{ id: number; name: string; receipts: number }[]>('/api/konten'),
    staleTime: 60_000,
  });
  // Only offer accounts that actually have receipts visible to this user.
  const konten = useMemo(() => (kontenRaw ?? []).filter(k => k.receipts > 0), [kontenRaw]);
  const updateKontoFilter = (id: string | null) => {
    setKontoFilter(id);
    const next = new URLSearchParams(params);
    if (id) next.set('konto', id); else next.delete('konto');
    setParams(next, { replace: true });
  };

  const [sizeIdx, setSizeIdx] = useState(() => {
    const saved = parseInt(localStorage.getItem(SIZE_KEY) ?? '', 10);
    return Number.isFinite(saved) && saved >= 0 && saved < SIZES.length ? saved : 1;
  });
  useEffect(() => { localStorage.setItem(SIZE_KEY, String(sizeIdx)); }, [sizeIdx]);
  const size = SIZES[sizeIdx];

  // Filter query string carried into the detail view so prev/next stay
  // within the currently-filtered list.
  const filterQs = useMemo(() => {
    const p = new URLSearchParams();
    if (storeFilter) p.set('store', storeFilter);
    if (kontoFilter) p.set('konto', kontoFilter);
    if (search.trim()) p.set('q', search.trim());
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [storeFilter, kontoFilter, search]);

  const gridRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const recompute = () => setCols(Math.max(1, Math.floor(el.clientWidth / size.min)));
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size.min]);
  const singleColumn = cols <= 1;

  // Sync ?store= / ?konto= URL params ↔ filter state
  useEffect(() => {
    const s = params.get('store');
    if (s !== storeFilter) setStoreFilter(s);
    const k = params.get('konto');
    if (k !== kontoFilter) setKontoFilter(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Horizontal store-chip scroller (desktop has no swipe → arrow buttons)
  const chipsRef = useRef<HTMLDivElement>(null);
  const [chipScroll, setChipScroll] = useState({ left: false, right: false });
  const updateChipScroll = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    setChipScroll({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);
  const scrollChips = (dir: -1 | 1) => {
    chipsRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' });
  };

  const updateStoreFilter = (key: string | null) => {
    setStoreFilter(key);
    const next = new URLSearchParams(params);
    if (key) next.set('store', key); else next.delete('store');
    setParams(next, { replace: true });
  };

  const { data: stores } = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<Store[]>('/api/stores'),
    staleTime: 60_000,
  });

  // Recompute chip-scroll arrows once the chips render / on resize.
  useEffect(() => {
    updateChipScroll();
    const el = chipsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateChipScroll);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stores, updateChipScroll]);

  const { data: progress } = useQuery({
    queryKey: ['review-progress', kontoFilter],
    queryFn: () => api<{ total: number; reviewed: number }>(
      `/api/receipts/review-progress${kontoFilter ? `?konto=${encodeURIComponent(kontoFilter)}` : ''}`,
    ),
  });

  const storeParam = storeFilter ? `&store=${encodeURIComponent(storeFilter)}` : '';
  const kontoParam = kontoFilter ? `&konto=${encodeURIComponent(kontoFilter)}` : '';
  const {
    data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['receipts', search, storeFilter, kontoFilter],
    queryFn: ({ pageParam }) =>
      api<Receipt[]>(`/api/receipts?limit=${PAGE}&offset=${pageParam}&q=${encodeURIComponent(search)}${storeParam}${kontoParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.length === PAGE ? all.length * PAGE : undefined),
  });

  const receipts = useMemo(() => data?.pages.flat() ?? [], [data]);

  // Infinite-scroll sentinel
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // ── month grouping + current-month tracking (for the scrubber) ──
  const months = useMemo(() => {
    const seen = new Set<string>();
    const out: { ym: string; label: string }[] = [];
    for (const r of receipts) {
      const ym = monthKeyOf(r.datum);
      if (!ym || seen.has(ym)) continue;
      seen.add(ym);
      const [y, m] = ym.split('-').map(Number);
      out.push({ ym, label: monthLabel(y, m, i18n.language) });
    }
    return out;
  }, [receipts, i18n.language]);

  const [currentYm, setCurrentYm] = useState<string | null>(null);
  const anchorRefs = useRef(new Map<string, HTMLDivElement>());
  const registerAnchor = useCallback((ym: string, el: HTMLDivElement | null) => {
    if (el) anchorRefs.current.set(ym, el);
    else anchorRefs.current.delete(ym);
  }, []);

  useEffect(() => {
    if (!singleColumn) return;
    const io = new IntersectionObserver(
      entries => {
        const top = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setCurrentYm(top.target.getAttribute('data-ym'));
      },
      { rootMargin: '-12% 0px -80% 0px' },
    );
    anchorRefs.current.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [singleColumn, receipts.length]);

  const jumpToMonth = (ym: string) => {
    anchorRefs.current.get(ym)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.reviewed / progress.total) * 100) : 0;

  // Track which month each card belongs to so we can drop anchors before the first of each.
  let lastYm = '';

  return (
    <div className="flex flex-col gap-3">
      {progress && progress.total > 0 && (
        <div className="rounded-2xl border border-zinc-200 bg-white px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-1.5 flex items-center justify-between text-sm">
            <span className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 size={15} className="text-emerald-500" />
              {t('receipts.reviewProgress')}
            </span>
            <span className="tabular text-zinc-500">
              {progress.reviewed} / {progress.total} · <span className="font-semibold text-emerald-600 dark:text-emerald-500">{pct}%</span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input
            className="pl-9 pr-9"
            placeholder={t('receipts.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
              title={t('common.clear')}
            >
              <X size={15} />
            </button>
          )}
        </div>
        {/* card-size slider */}
        <div className="flex shrink-0 items-center gap-1.5 rounded-xl border border-zinc-200 px-2.5 py-1.5 dark:border-zinc-800" title={t('receipts.cardSize')}>
          <Rows3 size={15} className="text-zinc-400" />
          <input
            type="range"
            min={0}
            max={SIZES.length - 1}
            value={sizeIdx}
            onChange={e => setSizeIdx(parseInt(e.target.value, 10))}
            className="w-16 accent-emerald-600 sm:w-24"
          />
        </div>
      </div>

      {konten && konten.length > 1 && (
        <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1">
          <button
            onClick={() => updateKontoFilter(null)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs font-medium',
              kontoFilter === null
                ? 'border-transparent bg-violet-600 text-white'
                : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
            )}
          >
            {t('receipts.allKonten')}
          </button>
          {konten.map(k => (
            <button
              key={k.id}
              onClick={() => updateKontoFilter(kontoFilter === String(k.id) ? null : String(k.id))}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium',
                kontoFilter === String(k.id)
                  ? 'border-transparent bg-violet-600 text-white'
                  : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
              )}
            >
              {k.name}
            </button>
          ))}
        </div>
      )}

      {stores && stores.length > 1 && (
        <div className="relative">
          {chipScroll.left && (
            <button
              onClick={() => scrollChips(-1)}
              className="absolute left-0 top-1/2 z-10 hidden -translate-y-1/2 rounded-full border border-zinc-200 bg-white/90 p-1 shadow-sm backdrop-blur hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900/90 dark:hover:bg-zinc-800 sm:block"
              title={t('common.scrollLeft')}
            >
              <ChevronLeft size={16} />
            </button>
          )}
          <div
            ref={chipsRef}
            onScroll={updateChipScroll}
            className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1"
          >
            <button
              onClick={() => updateStoreFilter(null)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1 text-xs font-medium',
                storeFilter === null
                  ? 'border-transparent bg-emerald-600 text-white'
                  : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
              )}
            >
              {t('receipts.allStores')}
            </button>
            {stores.map(s => (
              <button
                key={s.key}
                onClick={() => updateStoreFilter(storeFilter === s.key ? null : s.key)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border py-1 pl-1 pr-3 text-xs font-medium',
                  storeFilter === s.key
                    ? 'border-transparent bg-emerald-600 text-white'
                    : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
                )}
              >
                <StoreIcon storeKey={s.key} size={18} fallback={s.display[0]?.toUpperCase()} />
                {s.display} <span className="opacity-60">·{s.receipts}</span>
              </button>
            ))}
          </div>
          {chipScroll.right && (
            <button
              onClick={() => scrollChips(1)}
              className="absolute right-0 top-1/2 z-10 hidden -translate-y-1/2 rounded-full border border-zinc-200 bg-white/90 p-1 shadow-sm backdrop-blur hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900/90 dark:hover:bg-zinc-800 sm:block"
              title={t('common.scrollRight')}
            >
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      )}

      {isLoading && <Spinner />}
      {!isLoading && !receipts.length && <EmptyState>{t('receipts.empty')}</EmptyState>}

      <div className={singleColumn ? 'pr-12 sm:pr-14' : ''}>
        <div
          ref={gridRef}
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${size.min}px, 100%), 1fr))` }}
        >
          {receipts.map(r => {
            const ym = monthKeyOf(r.datum);
            const isFirstOfMonth = ym !== lastYm;
            lastYm = ym;
            return (
              <div key={r.id} className="contents">
                {isFirstOfMonth && singleColumn && (
                  <div ref={el => registerAnchor(ym, el)} data-ym={ym} className="col-span-full scroll-mt-20">
                    <div className="px-1 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      {months.find(m => m.ym === ym)?.label}
                    </div>
                  </div>
                )}
                <Card onClick={() => navigate(`/receipts/${r.id}${filterQs}`)} className="flex min-w-0 items-center gap-3 p-3">
                  {r.bild_pfad ? (
                    <img
                      src={r.bild_pfad}
                      alt=""
                      loading="lazy"
                      style={{ width: size.thumb * 0.75, height: size.thumb }}
                      className="shrink-0 rounded-lg border border-zinc-200 object-cover dark:border-zinc-700"
                    />
                  ) : (
                    <div
                      style={{ width: size.thumb * 0.75, height: size.thumb }}
                      className="flex shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-lg dark:bg-zinc-800"
                    >
                      🧾
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <div className="truncate font-semibold">{r.roh_ladenname ?? '?'}</div>
                      <span className="tabular shrink-0 text-[10px] font-medium text-zinc-400 dark:text-zinc-500">#{r.id}</span>
                    </div>
                    <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {fmtDate(r.datum, i18n.language)} · {r.item_count} {t('receipts.items')}
                    </div>
                    <div className="tabular mt-0.5 font-semibold text-emerald-600 dark:text-emerald-500">
                      {eur(r.gesamt_betrag)}
                    </div>
                  </div>
                  {r.geprueft && (
                    <span className="shrink-0 self-start" title={t('receiptDetail.reviewedYes')}>
                      <CheckCircle2 size={18} className="text-emerald-500" />
                    </span>
                  )}
                </Card>
              </div>
            );
          })}
        </div>
      </div>

      {/* infinite-scroll sentinel + spinner */}
      <div ref={sentinelRef} className="h-1" />
      {isFetchingNextPage && <Spinner className="py-4" />}

      {/* Immich-style month scrubber — only when single column */}
      {singleColumn && months.length > 1 && (
        <div className="fixed right-1.5 top-1/2 z-20 flex max-h-[68vh] -translate-y-1/2 flex-col items-end gap-0.5 overflow-y-auto rounded-2xl bg-white/70 px-1 py-2 backdrop-blur scrollbar-none dark:bg-zinc-900/70">
          {months.map(m => {
            const active = m.ym === currentYm;
            const [y, mm] = m.ym.split('-');
            return (
              <button
                key={m.ym}
                onClick={() => jumpToMonth(m.ym)}
                className={cn(
                  'tabular whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-medium transition',
                  active
                    ? 'scale-110 bg-emerald-600 text-white'
                    : 'text-zinc-400 hover:text-emerald-600 dark:text-zinc-500',
                )}
                title={m.label}
              >
                {active ? m.label : `${mm}.${y.slice(2)}`}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
