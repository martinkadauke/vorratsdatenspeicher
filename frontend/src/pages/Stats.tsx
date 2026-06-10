import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, ChevronDown, Pencil, Check, X } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { SpendingNode, SpendingTree } from '../api/types';
import { Card, Spinner, Modal, Input, Button, EmptyState } from '../components/ui';
import { useFamily } from '../components/ConsumerChips';
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
  const [member, setMember] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drill, setDrill] = useState<SpendingNode | null>(null);
  const { data: family = [] } = useFamily();

  const shift = (delta: number) => {
    const total = year * 12 + (month - 1) + delta;
    setYear(Math.floor(total / 12));
    setMonth((total % 12 + 12) % 12 + 1);
  };

  const memberParam = member !== null ? `&member=${member}` : '';
  const { data: tree, isLoading } = useQuery({
    queryKey: ['spending-tree', year, month, member],
    queryFn: () => api<SpendingTree>(`/api/spending/tree?year=${year}&month=${month}${memberParam}`),
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
            'flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900',
            n.level === 1 && 'font-semibold',
          )}
          style={{ paddingLeft: `${(n.level - 1) * 20 + 8}px` }}
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
          <span className="tabular hidden shrink-0 text-xs text-zinc-400 sm:inline">→ {eur(n.projection)}</span>
          <span className="hidden shrink-0 sm:inline"><GoalCell node={n} year={year} month={month} /></span>
        </div>
        {isOpen && children.map(renderNode)}
      </div>
    );
  };

  const total = tree?.total;

  return (
    <div className="flex flex-col gap-4">
      {/* Month nav */}
      <div className="flex items-center justify-between">
        <button onClick={() => shift(-1)} className="rounded-xl p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"><ChevronLeft size={20} /></button>
        <h1 className="text-lg font-bold">{monthLabel(year, month, i18n.language)}</h1>
        <button onClick={() => shift(1)} className="rounded-xl p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"><ChevronRight size={20} /></button>
      </div>

      {/* Member filter */}
      <div className="scrollbar-none flex gap-1.5 overflow-x-auto">
        <button
          onClick={() => setMember(null)}
          className={cn(
            'shrink-0 rounded-full border px-3 py-1 text-sm font-medium',
            member === null ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
          )}
        >
          {t('stats.all')}
        </button>
        {family.map(m => (
          <button
            key={m.id}
            onClick={() => setMember(member === m.id ? null : m.id)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-sm font-medium',
              member === m.id ? 'border-transparent text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
            )}
            style={member === m.id ? { backgroundColor: m.color ?? '#10b981' } : undefined}
          >
            {m.emoji ? `${m.emoji} ` : ''}{m.name}
          </button>
        ))}
      </div>

      {isLoading && <Spinner />}

      {total && (
        <Card className="flex flex-col gap-2 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-zinc-500">{t('stats.total')}</span>
            <GoalCell node={total} year={year} month={month} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="tabular text-3xl font-bold">{eur(total.mtd)}</span>
            {total.goal !== null && <span className="text-sm text-zinc-400">/ {eur(total.goal)}</span>}
          </div>
          <ProgressBar spent={total.mtd} goal={total.goal} projection={total.projection} />
          <div className="flex items-center justify-between text-xs text-zinc-500">
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
        </Card>
      )}

      {/* Category tree */}
      {tree && (
        <Card className="p-2">
          {(childrenOf.get(null) ?? []).map(renderNode)}
          {!tree.nodes.some(n => n.mtd > 0) && <EmptyState>{t('stats.noData')}</EmptyState>}
        </Card>
      )}

      {/* Drilldown */}
      <DrilldownModal node={drill} onClose={() => setDrill(null)} year={year} month={month} member={member} />
    </div>
  );
}

function DrilldownModal({ node, onClose, year, month, member }: {
  node: SpendingNode | null; onClose: () => void; year: number; month: number; member: number | null;
}) {
  const { t, i18n } = useTranslation();
  const memberParam = member !== null ? `&member=${member}` : '';

  const { data: history } = useQuery({
    queryKey: ['spending-history', node?.path, member],
    queryFn: () => api<HistoryPoint[]>(`/api/spending/history?path=${encodeURIComponent(node!.path)}&months=12${memberParam}`),
    enabled: !!node,
  });

  const { data: items } = useQuery({
    queryKey: ['spending-items', node?.path, year, month, member],
    queryFn: () => api<SpendItem[]>(`/api/spending/items?path=${encodeURIComponent(node!.path)}&year=${year}&month=${month}${memberParam}`),
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
          <h3 className="mb-2 text-sm font-medium text-zinc-500">{t('stats.items')} ({monthLabel(year, month, i18n.language)})</h3>
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
