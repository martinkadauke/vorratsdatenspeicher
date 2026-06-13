import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Search, X, Rows3, CheckSquare, Square, Users, Ban, Tag, Bell, FolderTree, ReceiptText, SlidersHorizontal } from 'lucide-react';
import { api } from '../api/client';
import type { CanonicalName } from '../api/types';
import { Card, Input, Label, Spinner, EmptyState, Badge, Select, Button, Modal } from '../components/ui';
import { CategoryPicker } from '../components/CategoryPicker';
import { CanonicalIcon } from '../components/IconPicker';
import { ConsumerDots, ConsumerChips } from '../components/ConsumerChips';
import { toast } from '../components/Toast';
import { NameEditModal } from './Names';
import { cn, eur, fmtDate } from '../lib/utils';

interface ArtikelGroup {
  key: string;
  display: string;
  has_canonical: boolean;
  canonical_name: string | null;
  count: number;
  category: string | null;
  last_bought: string | null;
  avg_price: string | null;
  artikel_ids: number[];
  einkauf_id: number | null;
  sample_artikel_id: number | null;
  consumers: number[];
}

type SortMode = 'alpha' | 'date' | 'category' | 'count';

const SIZES = [
  { min: 200, icon: 24 },
  { min: 280, icon: 32 },
  { min: 380, icon: 44 },
];
const SIZE_KEY = 'vds.artikelCardSize';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const DATE_PRESETS = [
  { key: '3w', i18n: 'artikel.preset3w', from: () => iso(new Date(Date.now() - 21 * 864e5)), to: () => iso(new Date()) },
  { key: 'month', i18n: 'artikel.presetMonth', from: () => iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), to: () => iso(new Date()) },
  { key: '3m', i18n: 'artikel.preset3m', from: () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return iso(d); }, to: () => iso(new Date()) },
  { key: 'year', i18n: 'artikel.presetYear', from: () => iso(new Date(new Date().getFullYear(), 0, 1)), to: () => iso(new Date()) },
] as const;

export function Artikel() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('alpha');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<CanonicalName | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [canonicalOpen, setCanonicalOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [pickedCategory, setPickedCategory] = useState<string | null>(null);
  // category + time-range filter
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterCat, setFilterCat] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filterQs = [
    filterCat ? `category=${encodeURIComponent(filterCat)}` : '',
    from ? `from=${from}` : '',
    to ? `to=${to}` : '',
  ].filter(Boolean).join('&');
  const filterActive = !!(filterCat || from || to);

  const [sizeIdx, setSizeIdx] = useState(() => {
    const s = parseInt(localStorage.getItem(SIZE_KEY) ?? '', 10);
    return Number.isFinite(s) && s >= 0 && s < SIZES.length ? s : 1;
  });
  useEffect(() => { localStorage.setItem(SIZE_KEY, String(sizeIdx)); }, [sizeIdx]);
  const size = SIZES[sizeIdx];

  const { data, isLoading } = useQuery({
    queryKey: ['artikel-list', search, filterQs],
    queryFn: () => api<ArtikelGroup[]>(`/api/artikel-list?q=${encodeURIComponent(search)}${filterQs ? `&${filterQs}` : ''}`),
  });
  const { data: spend } = useQuery({
    queryKey: ['artikel-spend', search, filterQs],
    queryFn: () => api<{ items: number; total: string }>(`/api/artikel-spend?q=${encodeURIComponent(search)}${filterQs ? `&${filterQs}` : ''}`),
    enabled: filterActive,
  });
  const { data: avoidedList } = useQuery({
    queryKey: ['avoided'],
    queryFn: () => api<string[]>('/api/avoided'),
    staleTime: 60_000,
  });
  const avoided = useMemo(() => new Set(avoidedList ?? []), [avoidedList]);
  const { data: subsData } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => api<{ filiale: number[]; artikel: string[] }>('/api/subscriptions'),
    staleTime: 60_000,
  });
  const subscribed = useMemo(() => new Set(subsData?.artikel ?? []), [subsData]);
  const isSubscribed = (g: ArtikelGroup) => subscribed.has(g.canonical_name ?? g.display);

  // membership filters (subscribed / avoided)
  const [onlySub, setOnlySub] = useState(false);
  const [onlyAvoided, setOnlyAvoided] = useState(false);

  // keyboard: F → jump to search, C → open filters & jump to category search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (document.querySelector('.fixed.inset-0.z-50')) return; // a modal is open
      const k = e.key.toLowerCase();
      if (k === 'f') { e.preventDefault(); document.getElementById('artikel-search')?.focus(); }
      else if (k === 'c') {
        e.preventDefault();
        setFilterOpen(true);
        setTimeout(() => document.getElementById('artikel-cat-search')?.focus(), 30);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sorted = useMemo(() => {
    const rows = [...(data ?? [])];
    rows.sort((a, b) => {
      if (sort === 'count') return b.count - a.count;
      if (sort === 'date') return (b.last_bought ?? '').localeCompare(a.last_bought ?? '');
      if (sort === 'category') return (a.category ?? 'zzz').localeCompare(b.category ?? 'zzz', i18n.language);
      return a.display.localeCompare(b.display, i18n.language);
    });
    return rows;
  }, [data, sort, i18n.language]);

  const visible = useMemo(() => {
    if (!onlySub && !onlyAvoided) return sorted;
    return sorted.filter(g => {
      const sub = onlySub && isSubscribed(g);
      const av = onlyAvoided && !!g.canonical_name && avoided.has(g.canonical_name);
      return sub || av;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, onlySub, onlyAvoided, subscribed, avoided]);

  const allSelected = visible.length > 0 && visible.every(r => selected.has(r.key));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(visible.map(r => r.key)));
  };
  const toggleOne = (key: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const selectedGroups = sorted.filter(r => selected.has(r.key));

  const assign = useMutation({
    mutationFn: (memberIds: number[]) => {
      const canonical_names = selectedGroups.filter(g => g.canonical_name).map(g => g.canonical_name!);
      const artikel_ids = selectedGroups.filter(g => !g.canonical_name).flatMap(g => g.artikel_ids);
      return api('/api/artikel/assign-consumers', { method: 'POST', body: { canonical_names, artikel_ids, member_ids: memberIds } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['artikel-list'] });
      void qc.invalidateQueries({ queryKey: ['names'] });
      setAssignOpen(false);
      setSelected(new Set());
      toast(t('artikel.assigned'), 'success');
    },
  });

  const setCanonical = useMutation({
    mutationFn: (name: string) => {
      const artikel_ids = selectedGroups.flatMap(g => g.artikel_ids);
      return api('/api/artikel/set-canonical', { method: 'POST', body: { artikel_ids, canonical_name: name } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['artikel-list'] });
      void qc.invalidateQueries({ queryKey: ['names'] });
      setCanonicalOpen(false);
      setSelected(new Set());
      toast(t('artikel.canonicalSet'), 'success');
    },
  });

  const setCategory = useMutation({
    mutationFn: (categoryPath: string) => {
      const artikel_ids = selectedGroups.flatMap(g => g.artikel_ids);
      return api('/api/artikel/set-category', { method: 'POST', body: { artikel_ids, category_path: categoryPath } });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['artikel-list'] });
      void qc.invalidateQueries({ queryKey: ['names'] });
      setCategoryOpen(false);
      setPickedCategory(null);
      setSelected(new Set());
      toast(t('artikel.categorySet'), 'success');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const subscribeOffers = useMutation({
    mutationFn: () => {
      const refs = selectedGroups.map(g => g.canonical_name ?? g.display).filter(Boolean);
      return api<{ subscribed: number }>('/api/subscriptions/bulk', { method: 'POST', body: { kind: 'artikel', refs } });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['subscriptions'] });
      setSelected(new Set());
      toast(t('artikel.subscribed', { count: r.subscribed }), 'success');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  // "Vermeiden": only canonical groups can be avoided (the list keys on canonical_name).
  const avoidNames = selectedGroups.map(g => g.canonical_name).filter(Boolean) as string[];
  const allAvoided = avoidNames.length > 0 && avoidNames.every(n => avoided.has(n));
  const toggleAvoid = useMutation({
    mutationFn: () => api<{ count: number }>('/api/avoided', { method: 'POST', body: { canonical_names: avoidNames, avoid: !allAvoided } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['avoided'] });
      void qc.invalidateQueries({ queryKey: ['artikel-list'] });
      setSelected(new Set());
      toast(allAvoided ? t('artikel.unavoided') : t('artikel.avoided', { count: avoidNames.length }), 'success');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const openDetail = (g: ArtikelGroup) => {
    if (!g.canonical_name) { toggleOne(g.key); return; } // loose items: select only
    setDetail({
      canonical_name: g.canonical_name,
      artikel_count: g.count,
      category_path: g.category,
      last_bought: g.last_bought,
      translation_en: null,
      consumers: g.consumers,
      consumers_exclusive: false,
    });
  };

  return (
    <div className="flex flex-col gap-3 pb-20">
      <h1 className="text-lg font-bold">{t('nav.names')}</h1>

      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input id="artikel-search" className="pl-9 pr-9" placeholder={t('artikel.search')} title={`${t('common.searchOps')} · [F]`} value={search} onChange={e => setSearch(e.target.value)} />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={15} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Select value={sort} onChange={e => setSort(e.target.value as SortMode)} className="min-w-0 flex-1">
          <option value="alpha">{t('artikel.sortAlpha')}</option>
          <option value="count">{t('artikel.sortCount')}</option>
          <option value="date">{t('artikel.sortDate')}</option>
          <option value="category">{t('artikel.sortCategory')}</option>
        </Select>
        <button
          onClick={() => setFilterOpen(o => !o)}
          className={cn('flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-2 text-sm',
            filterActive ? 'border-emerald-400 text-emerald-600' : 'border-zinc-200 text-zinc-500 dark:border-zinc-800')}
        >
          <SlidersHorizontal size={15} />{filterActive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
        </button>
        <div className="flex shrink-0 items-center gap-1.5 rounded-xl border border-zinc-200 px-2.5 py-2 dark:border-zinc-800">
          <Rows3 size={15} className="text-zinc-400" />
          <input type="range" min={0} max={SIZES.length - 1} value={sizeIdx} onChange={e => setSizeIdx(parseInt(e.target.value, 10))} className="w-16 accent-emerald-600 sm:w-24" />
        </div>
      </div>

      {(subscribed.size > 0 || avoided.size > 0 || onlySub || onlyAvoided) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOnlySub(v => !v)}
            className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
              onlySub ? 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-zinc-200 text-zinc-500 dark:border-zinc-700')}
          >
            <Bell size={13} /> {t('artikel.filterSubscribed')} <span className="text-zinc-400">{subscribed.size}</span>
          </button>
          <button
            type="button"
            onClick={() => setOnlyAvoided(v => !v)}
            className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
              onlyAvoided ? 'border-red-400 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                : 'border-zinc-200 text-zinc-500 dark:border-zinc-700')}
          >
            <Ban size={13} /> {t('artikel.filterAvoided')} <span className="text-zinc-400">{avoided.size}</span>
          </button>
        </div>
      )}

      {filterOpen && (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div>
            <Label>{t('artikel.filterCategory')} <span className="font-normal text-zinc-400">· [C]</span></Label>
            <CategoryPicker value={filterCat} onChange={setFilterCat} inputId="artikel-cat-search" />
          </div>
          <div>
            <Label>{t('artikel.filterPeriod')}</Label>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {DATE_PRESETS.map(p => (
                <button key={p.key} type="button" onClick={() => { setFrom(p.from()); setTo(p.to()); }}
                  className="rounded-full border border-zinc-300 px-2.5 py-1 text-xs hover:border-emerald-400 hover:text-emerald-600 dark:border-zinc-700">
                  {t(p.i18n)}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} />
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} />
            </div>
          </div>
          {filterActive && (
            <button type="button" onClick={() => { setFilterCat(null); setFrom(''); setTo(''); }}
              className="self-start text-xs text-zinc-400 hover:text-red-500">{t('artikel.filterClear')}</button>
          )}
        </div>
      )}
      {filterActive && spend && (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-950/30">
          <span className="text-base font-semibold text-emerald-700 dark:text-emerald-300">{eur(spend.total)}</span>
          <span className="text-zinc-500 dark:text-zinc-400">· {spend.items} {t('artikel.items')}</span>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <button onClick={toggleAll} className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {allSelected ? <CheckSquare size={15} className="text-emerald-500" /> : <Square size={15} />}
          {t('artikel.selectAll')}
        </button>
        <span>{visible.length} {t('artikel.items')}</span>
      </div>

      {isLoading && <Spinner />}
      {!isLoading && !visible.length && <EmptyState>–</EmptyState>}

      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${size.min}px, 100%), 1fr))` }}>
        {visible.map(g => {
          const isSel = selected.has(g.key);
          return (
            <Card key={g.key} className={cn('flex min-w-0 items-center gap-2 px-2.5 py-2', isSel && 'ring-2 ring-emerald-400')}>
              <button onClick={() => toggleOne(g.key)} className="shrink-0 text-zinc-400 hover:text-emerald-500" aria-label={t('artikel.select')}>
                {isSel ? <CheckSquare size={18} className="text-emerald-500" /> : <Square size={18} />}
              </button>
              <button onClick={() => openDetail(g)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {g.has_canonical && g.canonical_name
                  ? <CanonicalIcon name={g.canonical_name} size={size.icon} />
                  : <span className="shrink-0" style={{ width: size.icon, height: size.icon }} />}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={cn('truncate font-medium', !g.has_canonical && 'italic text-zinc-500 dark:text-zinc-400')}>{g.display}</span>
                    {g.canonical_name && avoided.has(g.canonical_name) && (
                      <Ban size={13} className="shrink-0 text-red-500" aria-label={t('artikel.avoid')} />
                    )}
                    {isSubscribed(g) && (
                      <Bell size={13} className="shrink-0 text-emerald-500" aria-label={t('artikel.filterSubscribed')} />
                    )}
                    <ConsumerDots ids={g.consumers} />
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-zinc-400">
                    <Badge>{g.count}×</Badge>
                    {g.category && <Badge className="max-w-[40vw] truncate sm:max-w-none">{g.category.split('/').pop()}</Badge>}
                    {g.avg_price && <span>Ø {eur(g.avg_price)}</span>}
                    {g.last_bought && <span>· {fmtDate(g.last_bought, i18n.language)}</span>}
                  </div>
                </div>
              </button>
              {/* loose items (no canonical name): jump to the source receipt */}
              {!g.has_canonical && g.einkauf_id != null && (
                <button
                  onClick={() => navigate(`/receipts/${g.einkauf_id}${g.sample_artikel_id ? `?highlight=${g.sample_artikel_id}` : ''}`)}
                  title={t('artikel.openReceipt')}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30"
                >
                  <ReceiptText size={16} />
                </button>
              )}
            </Card>
          );
        })}
      </div>

      {/* selection action bar */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 mx-auto flex max-w-2xl items-center gap-2 rounded-2xl border border-zinc-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 md:bottom-4">
          <span className="text-sm font-medium">{selected.size} {t('artikel.selected')}</span>
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setCanonicalOpen(true)}>
              <Tag size={15} /> {t('artikel.setCanonical')}
            </Button>
            <Button variant="secondary" onClick={() => { setPickedCategory(null); setCategoryOpen(true); }}>
              <FolderTree size={15} /> {t('artikel.setCategory')}
            </Button>
            <Button variant="secondary" onClick={() => setAssignOpen(true)}>
              <Users size={15} /> {t('artikel.assignMembers')}
            </Button>
            <Button variant="secondary" onClick={() => subscribeOffers.mutate()} disabled={subscribeOffers.isPending}>
              <Bell size={15} /> {t('artikel.subscribeOffers')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => toggleAvoid.mutate()}
              disabled={!avoidNames.length || toggleAvoid.isPending}
              title={!avoidNames.length ? t('artikel.avoidNeedsCanonical') : ''}
            >
              <Ban size={15} /> {allAvoided ? t('artikel.unavoid') : t('artikel.avoid')}
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              <X size={15} />
            </Button>
          </div>
        </div>
      )}

      <NameEditModal name={detail} onClose={() => setDetail(null)} />
      <Modal open={categoryOpen} onClose={() => setCategoryOpen(false)} title={t('artikel.setCategoryTitle', { count: selected.size })}>
        <div className="flex flex-col gap-3">
          <CategoryPicker value={pickedCategory} onChange={setPickedCategory} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCategoryOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={() => pickedCategory && setCategory.mutate(pickedCategory)} disabled={!pickedCategory || setCategory.isPending}>
              {setCategory.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>
      <AssignMembersModal
        open={assignOpen}
        count={selected.size}
        pending={assign.isPending}
        onClose={() => setAssignOpen(false)}
        onApply={ids => assign.mutate(ids)}
      />
      <SetCanonicalModal
        open={canonicalOpen}
        count={selected.size}
        suggestion={selectedGroups.length === 1 ? selectedGroups[0].display : ''}
        pending={setCanonical.isPending}
        onClose={() => setCanonicalOpen(false)}
        onApply={name => setCanonical.mutate(name)}
      />
    </div>
  );
}

function SetCanonicalModal({ open, count, suggestion, pending, onClose, onApply }: {
  open: boolean; count: number; suggestion: string; pending: boolean; onClose: () => void; onApply: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  useEffect(() => { if (open) setName(suggestion); }, [open, suggestion]);

  return (
    <Modal open={open} onClose={onClose} title={t('artikel.setCanonicalTitle', { count })}>
      <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); if (name.trim() && !pending) onApply(name.trim()); }}>
        <Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t('article.canonical')} />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('artikel.setCanonicalHint')}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!name.trim() || pending}>{t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function AssignMembersModal({ open, count, pending, onClose, onApply }: {
  open: boolean; count: number; pending: boolean; onClose: () => void; onApply: (ids: number[]) => void;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<number[]>([]);
  useEffect(() => { if (open) setMembers([]); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={t('artikel.assignTitle', { count })}>
      <div className="flex flex-col gap-4">
        <ConsumerChips selected={members} onChange={setMembers} />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('artikel.assignHint')}</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => onApply(members)} disabled={pending}>{t('common.save')}</Button>
        </div>
      </div>
    </Modal>
  );
}
