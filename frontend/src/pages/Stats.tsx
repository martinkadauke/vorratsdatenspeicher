import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, ChevronDown, Pencil, Check, X, Search, SlidersHorizontal } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { SpendingNode, SpendingTree } from '../api/types';
import { Card, Spinner, Modal, Input, Button, EmptyState } from '../components/ui';
import { cn, eur, monthLabel, fmtDate } from '../lib/utils';

interface HistoryPoint { ym: string; spend: number }
interface SpendItem {
  id: number; name: string | null; canonical_name: string | null; preis: string | null;
  einkauf_id: number; datum: string; roh_ladenname: string | null; member_share?: number;
}

function GoalCell({ node, year, month }: { node: SpendingNode; year: number; month: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const save = useMutation({
    mutationFn: (goal: number | null) =>
      api('/api/goals', { method: 'PUT', body: { category_path: node.path, year, month, goal_eur: goal } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['spending-tree'] }); setEditing(false); },
  });

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1">
        <Input
          className="h-7 w-20 px-2 py-0 text-right text-xs"
          inputMode="decimal"
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') save.mutate(value === '' ? null : parseFloat(value.replace(',', '.')));
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <button onClick={() => save.mutate(value === '' ? null : parseFloat(value.replace(',', '.')))} className="text-emerald-600"><Check size={14} /></button>
        <button onClick={() => setEditing(false)} className="text-zinc-400"><X size={14} /></button>
      </span>
    );
  }

  return (
    <button
      onClick={() => { setValue(node.goal !== null ? String(node.goal) : node.avg3 ? String(Math.round(node.avg3)) : ''); setEditing(true); }}
      className="group inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
      title={node.goal === null ? t('stats.setGoal') : t('common.edit')}
    >
      <span className={cn('tabular text-xs', node.goal !== null && 'font-medium text-zinc-600 dark:text-zinc-300')}>
        {node.goal !== null ? eur(node.goal) : '—'}
      </span>
      <Pencil size={11} className="opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}

function ProgressBar({ spent, goal, projection }: { spent: number; goal: number | null; projection: number }) {
  if (!goal) return null;
  const pct = Math.min((spent / goal) * 100, 100);
  const projPct = Math.min((projection / goal) * 100, 100);
  const danger = projection > goal;
  const warn = !danger && projection > goal * 0.9;
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      <div className="absolute inset-y-0 left-0 rounded-full bg-zinc-300 opacity-60 dark:bg-zinc-600" style={{ width: `${projPct}%` }} />
      <div
        className={cn('absolute inset-y-0 left-0 rounded-full', danger ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-emerald-500')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Stats() {
  const { t, i18n } = useTranslation();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drill, setDrill] = useState<SpendingNode | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [konten, setKonten] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');

  const shift = (delta: number) => {
    const total = year * 12 + (month - 1) + delta;
    setYear(Math.floor(total / 12));
    setMonth((total % 12 + 12) % 12 + 1);
  };

  // A from+to range overrides the single month (projection/goal/avg are month-only).
  const rangeMode = !!(from && to);
  const kIds = useMemo(() => [...konten], [konten]);
  const kParam = kIds.length ? `&konten=${kIds.join(',')}` : '';
  const rangeParam = rangeMode ? `&from=${from}&to=${to}` : '';
  const hasActiveFilters = rangeMode || kIds.length > 0;

  const { data: accounts = [] } = useQuery({
    queryKey: ['konten'],
    queryFn: () => api<{ id: number; name: string; receipts: number }[]>('/api/konten'),
  });
  const acctOptions = useMemo(() => accounts.filter(a => a.receipts > 0), [accounts]);
  const toggleKonto = (id: number) => setKonten(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chipCls = (active: boolean) => cn('shrink-0 rounded-full border px-3 py-1 text-sm font-medium', active ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700');

  const { data: tree, isLoading } = useQuery({
    queryKey: ['spending-tree', year, month, from, to, kParam],
    queryFn: () => api<SpendingTree>(`/api/spending/tree?year=${year}&month=${month}${rangeParam}${kParam}`),
  });

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, SpendingNode[]>();
    for (const n of tree?.nodes ?? []) {
      const key = n.parent_path ?? null;
      const list = map.get(key) ?? [];
      list.push(n);
      map.set(key, list);
    }
    return map;
  }, [tree]);

  const toggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (n: SpendingNode): React.ReactNode => {
    const children = childrenOf.get(n.path) ?? [];
    const hasData = n.mtd > 0 || n.avg3 > 0 || n.goal !== null;
    if (!hasData && !children.some(c => c.mtd > 0 || c.avg3 > 0)) return null;
    const isOpen = expanded.has(n.path);
    const over = n.goal !== null && n.projection > n.goal;

    return (
      <div key={n.path}>
        <div
          className={cn(
            'flex items-center gap-1.5 rounded-xl px-1.5 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900 sm:gap-2 sm:px-2',
            n.level === 1 && 'font-semibold',
          )}
          style={{ paddingLeft: `${(n.level - 1) * 14 + 6}px` }}
        >
          <button
            onClick={() => children.length ? toggle(n.path) : setDrill(n)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            {children.length > 0 && (
              <ChevronDown size={14} className={cn('shrink-0 text-zinc-400 transition-transform', !isOpen && '-rotate-90')} />
            )}
            {n.emoji && <span>{n.emoji}</span>}
            <span className="truncate hover:underline" onClick={e => { e.stopPropagation(); setDrill(n); }}>{n.label}</span>
          </button>
          <span className={cn('tabular shrink-0 text-sm', over && 'text-red-500')}>{eur(n.mtd)}</span>
          {!rangeMode && <span className="tabular hidden shrink-0 text-xs text-zinc-400 sm:inline">→ {eur(n.projection)}</span>}
          {!rangeMode && <span className="hidden shrink-0 sm:inline"><GoalCell node={n} year={year} month={month} /></span>}
        </div>
        {isOpen && children.map(renderNode)}
      </div>
    );
  };

  const total = tree?.total;
  const searchLc = search.trim().toLowerCase();
  const searchHits = searchLc
    ? (tree?.nodes ?? []).filter(n => n.mtd > 0 && n.label.toLowerCase().includes(searchLc)).sort((a, b) => b.mtd - a.mtd)
    : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Month carousel — or the active date range */}
      <div className="flex items-center justify-between">
        {rangeMode ? (
          <>
            <span className="w-9 shrink-0" />
            <h1 className="text-lg font-bold">{fmtDate(from, i18n.language)} – {fmtDate(to, i18n.language)}</h1>
            <button onClick={() => { setFrom(''); setTo(''); }} className="rounded-xl px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-500" title={t('stats.monthReset')}>{t('stats.monthReset')}</button>
          </>
        ) : (
          <>
            <button onClick={() => shift(-1)} className="rounded-xl p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"><ChevronLeft size={20} /></button>
            <h1 className="text-lg font-bold">{monthLabel(year, month, i18n.language)}</h1>
            <button onClick={() => shift(1)} className="rounded-xl p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"><ChevronRight size={20} /></button>
          </>
        )}
      </div>

      {/* Search + filter bar (Receipts style) */}
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-9 pr-9" placeholder={t('stats.searchPlaceholder')} value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"><X size={16} /></button>}
        </div>
        <button type="button" onClick={() => setFiltersOpen(o => !o)} aria-pressed={filtersOpen} title={t('stats.filters')}
          className={cn('relative flex shrink-0 items-center rounded-xl border px-2.5 transition',
            filtersOpen ? 'border-emerald-500 bg-emerald-50 text-emerald-600 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' : 'border-zinc-200 text-zinc-400 hover:text-zinc-600 dark:border-zinc-800')}>
          <SlidersHorizontal size={16} />
          {hasActiveFilters && !filtersOpen && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-950" />}
        </button>
      </div>

      {/* Filter panel */}
      {filtersOpen && (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-zinc-400">{t('stats.dateRange')}</div>
            <div className="flex items-center gap-2">
              <Input type="date" className="min-w-0 flex-1" value={from} onChange={e => setFrom(e.target.value)} />
              <span className="shrink-0 text-zinc-400">–</span>
              <Input type="date" className="min-w-0 flex-1" value={to} onChange={e => setTo(e.target.value)} />
              {rangeMode && <button onClick={() => { setFrom(''); setTo(''); }} className="shrink-0 rounded-lg p-1 text-zinc-400 hover:text-zinc-600" title={t('stats.monthReset')}><X size={16} /></button>}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[11px] font-medium text-zinc-400">{t('stats.accounts')}</div>
            <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1">
              <button onClick={() => setKonten(new Set())} className={chipCls(kIds.length === 0)}>{t('stats.allAccounts')}</button>
              {acctOptions.map(a => <button key={a.id} onClick={() => toggleKonto(a.id)} className={chipCls(konten.has(a.id))}>{a.name}</button>)}
            </div>
          </div>
        </div>
      )}

      {isLoading && <Spinner />}

      {total && (
        <Card className="flex flex-col gap-2 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-zinc-500">{t('stats.total')}</span>
            {!rangeMode && <GoalCell node={total} year={year} month={month} />}
          </div>
          <div className="flex items-baseline gap-2">
            <span className="tabular text-3xl font-bold">{eur(total.mtd)}</span>
            {!rangeMode && total.goal !== null && <span className="text-sm text-zinc-400">/ {eur(total.goal)}</span>}
          </div>
          {!rangeMode && (
            <>
              <ProgressBar spent={total.mtd} goal={total.goal} projection={total.projection} />
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-zinc-500">
                <span>
                  {t('stats.projection')}: <span className={cn('tabular font-semibold', total.goal !== null && total.projection > total.goal ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-500')}>{eur(total.projection)}</span>
                  {total.goal !== null && (
                    <span className="ml-1">
                      ({total.projection > total.goal ? `⚠ ${t('stats.overGoal')}` : `✓ ${t('stats.onTrack')}`})
                    </span>
                  )}
                </span>
                <span>{t('stats.avg3')}: <span className="tabular">{eur(total.avg3)}</span></span>
              </div>
              {tree.is_current_month && (
                <div className="text-xs text-zinc-400">
                  {t('stats.day')} {tree.days_elapsed}/{tree.days_total}
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* Search results (flat, matching categories) OR the category tree */}
      {tree && searchLc && (
        <Card className="p-2">
          {searchHits.map(n => (
            <button key={n.path} onClick={() => setDrill(n)}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900">
              {n.emoji && <span>{n.emoji}</span>}
              <span className="min-w-0 flex-1 truncate">{n.label}</span>
              <span className="tabular shrink-0 text-sm">{eur(n.mtd)}</span>
            </button>
          ))}
          {!searchHits.length && <EmptyState>{t('stats.noData')}</EmptyState>}
        </Card>
      )}
      {tree && !searchLc && (
        <Card className="p-2">
          {(childrenOf.get(null) ?? []).map(renderNode)}
          {!tree.nodes.some(n => n.mtd > 0) && <EmptyState>{t('stats.noData')}</EmptyState>}
        </Card>
      )}

      {/* Drilldown */}
      <DrilldownModal node={drill} onClose={() => setDrill(null)} year={year} month={month} from={from} to={to} kParam={kParam} />
    </div>
  );
}

function DrilldownModal({ node, onClose, year, month, from, to, kParam }: {
  node: SpendingNode | null; onClose: () => void; year: number; month: number; from: string; to: string; kParam: string;
}) {
  const { t, i18n } = useTranslation();
  const rangeMode = !!(from && to);
  const rangeParam = rangeMode ? `&from=${from}&to=${to}` : '';
  const periodLabel = rangeMode ? `${fmtDate(from, i18n.language)} – ${fmtDate(to, i18n.language)}` : monthLabel(year, month, i18n.language);

  const { data: history } = useQuery({
    queryKey: ['spending-history', node?.path, kParam],
    queryFn: () => api<HistoryPoint[]>(`/api/spending/history?path=${encodeURIComponent(node!.path)}&months=12${kParam}`),
    enabled: !!node,
  });

  const { data: items } = useQuery({
    queryKey: ['spending-items', node?.path, year, month, rangeParam, kParam],
    queryFn: () => api<SpendItem[]>(`/api/spending/items?path=${encodeURIComponent(node!.path)}&year=${year}&month=${month}${rangeParam}${kParam}`),
    enabled: !!node,
  });

  if (!node) return null;

  return (
    <Modal open={!!node} onClose={onClose} title={`${node.emoji ?? ''} ${node.label}`} wide>
      <div className="flex flex-col gap-5">
        <div>
          <h3 className="mb-2 text-sm font-medium text-zinc-500">{t('stats.history')}</h3>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history ?? []} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" />
                <XAxis dataKey="ym" tick={{ fontSize: 10 }} tickFormatter={(ym: string) => ym.slice(5)} />
                <YAxis tick={{ fontSize: 10 }} width={45} tickFormatter={(v: number) => `${v}€`} />
                <Tooltip formatter={(v: number | string) => eur(Number(v))} labelFormatter={(l) => String(l)} />
                <Line type="monotone" dataKey="spend" stroke="#10b981" strokeWidth={2} dot={{ r: 2.5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium text-zinc-500">{t('stats.items')} ({periodLabel})</h3>
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {items?.map(it => (
              <Link
                key={it.id}
                to={`/receipts/${it.einkauf_id}`}
                onClick={onClose}
                className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
              >
                <span className="min-w-0">
                  <span className="block truncate">{it.canonical_name ?? it.name}</span>
                  <span className="text-xs text-zinc-400">{fmtDate(it.datum, i18n.language)} · {it.roh_ladenname}</span>
                </span>
                <span className="tabular ml-2 shrink-0 font-medium">
                  {eur(it.member_share ?? it.preis)}
                </span>
              </Link>
            ))}
            {!items?.length && <EmptyState>{t('stats.noData')}</EmptyState>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
