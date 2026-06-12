import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search, X, Rows3, CheckSquare, Square, Users, Ban, Tag } from 'lucide-react';
import { api } from '../api/client';
import type { CanonicalName } from '../api/types';
import { Card, Input, Spinner, EmptyState, Badge, Select, Button, Modal } from '../components/ui';
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
  consumers: number[];
}

type SortMode = 'alpha' | 'date' | 'category' | 'count';

const SIZES = [
  { min: 200, icon: 24 },
  { min: 280, icon: 32 },
  { min: 380, icon: 44 },
];
const SIZE_KEY = 'vds.artikelCardSize';

export function Artikel() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('alpha');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<CanonicalName | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [canonicalOpen, setCanonicalOpen] = useState(false);

  const [sizeIdx, setSizeIdx] = useState(() => {
    const s = parseInt(localStorage.getItem(SIZE_KEY) ?? '', 10);
    return Number.isFinite(s) && s >= 0 && s < SIZES.length ? s : 1;
  });
  useEffect(() => { localStorage.setItem(SIZE_KEY, String(sizeIdx)); }, [sizeIdx]);
  const size = SIZES[sizeIdx];

  const { data, isLoading } = useQuery({
    queryKey: ['artikel-list', search],
    queryFn: () => api<ArtikelGroup[]>(`/api/artikel-list?q=${encodeURIComponent(search)}`),
  });

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

  const allSelected = sorted.length > 0 && sorted.every(r => selected.has(r.key));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(sorted.map(r => r.key)));
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
        <Input className="pl-9 pr-9" placeholder={t('artikel.search')} value={search} onChange={e => setSearch(e.target.value)} />
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
        <div className="flex shrink-0 items-center gap-1.5 rounded-xl border border-zinc-200 px-2.5 py-2 dark:border-zinc-800">
          <Rows3 size={15} className="text-zinc-400" />
          <input type="range" min={0} max={SIZES.length - 1} value={sizeIdx} onChange={e => setSizeIdx(parseInt(e.target.value, 10))} className="w-16 accent-emerald-600 sm:w-24" />
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <button onClick={toggleAll} className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {allSelected ? <CheckSquare size={15} className="text-emerald-500" /> : <Square size={15} />}
          {t('artikel.selectAll')}
        </button>
        <span>{sorted.length} {t('artikel.items')}</span>
      </div>

      {isLoading && <Spinner />}
      {!isLoading && !sorted.length && <EmptyState>–</EmptyState>}

      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${size.min}px, 100%), 1fr))` }}>
        {sorted.map(g => {
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
            <Button variant="secondary" onClick={() => setAssignOpen(true)}>
              <Users size={15} /> {t('artikel.assignMembers')}
            </Button>
            <Button variant="ghost" onClick={() => toast(t('artikel.avoidWip'), 'info')} title="Work in progress">
              <Ban size={15} /> {t('artikel.avoid')}
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              <X size={15} />
            </Button>
          </div>
        </div>
      )}

      <NameEditModal name={detail} onClose={() => setDetail(null)} />
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
