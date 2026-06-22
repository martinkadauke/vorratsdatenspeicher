import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ReceiptText, Search, X, CheckSquare, Square, Check, Ban } from 'lucide-react';
import { api } from '../api/client';
import type { PruefenGroup } from '../api/types';
import { Card, Spinner, EmptyState, Button, Input } from '../components/ui';
import { CanonicalIcon } from '../components/IconPicker';
import { FirstVisitHint } from '../components/FirstVisitHint';
import { toast } from '../components/Toast';
import { cn } from '../lib/utils';
import { useUrlState } from '../hooks/useUrlState';

function confColor(c: string | null): string {
  const v = c ? parseFloat(c) : NaN;
  if (!Number.isFinite(v)) return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  if (v >= 0.7) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
  if (v >= 0.5) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
  return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';
}

export function Queue() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [search, setSearch] = useUrlState('q', '');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ['pruefen'],
    queryFn: () => api<{ items: PruefenGroup[]; total: number }>('/api/pruefen'),
  });
  const all = data?.items ?? [];
  const total = data?.total ?? 0;

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(g =>
      (g.original_text ?? '').toLowerCase().includes(q) ||
      (g.suggestion ?? '').toLowerCase().includes(q) ||
      (g.ai_guess ?? '').toLowerCase().includes(q));
  }, [all, search]);

  const valueOf = (g: PruefenGroup) => edits[g.grp] ?? g.suggestion ?? g.ai_guess ?? '';

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['pruefen'] });
    void qc.invalidateQueries({ queryKey: ['pruefen-count'] });
    void qc.invalidateQueries({ queryKey: ['names'] });
    void qc.invalidateQueries({ queryKey: ['artikel-list'] });
  };

  const decide = useMutation({
    mutationFn: (b: { artikel_ids: number[]; canonical?: string; action: string }) =>
      api('/api/pruefen/decide', { method: 'POST', body: b }),
    onSuccess: invalidate,
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const decideBulk = useMutation({
    mutationFn: (b: { action: string; items: { artikel_ids: number[]; canonical?: string }[] }) =>
      api<{ count: number }>('/api/pruefen/decide-bulk', { method: 'POST', body: b }),
    onSuccess: (r) => { invalidate(); setSelected(new Set()); toast(t('queue.bulkDone', { count: r.count }), 'success'); },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const allSelected = items.length > 0 && items.every(g => selected.has(g.grp));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map(g => g.grp)));
  const toggleOne = (grp: string) => setSelected(prev => {
    const n = new Set(prev); n.has(grp) ? n.delete(grp) : n.add(grp); return n;
  });

  const selectedGroups = items.filter(g => selected.has(g.grp));
  const bulkApprove = () => decideBulk.mutate({
    action: 'approve',
    items: selectedGroups.filter(g => valueOf(g).trim()).map(g => ({ artikel_ids: g.artikel_ids, canonical: valueOf(g).trim() })),
  });
  const bulkReject = () => decideBulk.mutate({
    action: 'reject', items: selectedGroups.map(g => ({ artikel_ids: g.artikel_ids })),
  });

  return (
    <div className="flex flex-col gap-3 pb-20">
      <h1 className="text-lg font-bold">{t('queue.title')}</h1>
      <FirstVisitHint id="queue1" titleKey="hint.queue.title" bodyKey="hint.queue.body" />

      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input className="pl-9 pr-9" placeholder={t('queue.search')} value={search} onChange={e => setSearch(e.target.value)} />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={15} />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <button onClick={toggleAll} className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {allSelected ? <CheckSquare size={15} className="text-emerald-500" /> : <Square size={15} />} {t('artikel.selectAll')}
        </button>
        <span>
          {t('queue.countOpen', { count: total })}
          {items.length < all.length ? ` · ${t('queue.showing', { n: items.length })}` : ''}
        </span>
      </div>

      {isLoading && <Spinner />}
      {!isLoading && !items.length && <EmptyState>{search ? '–' : t('queue.empty')}</EmptyState>}

      <div className="flex flex-col gap-2">
        {items.map(g => {
          const value = valueOf(g);
          const isSel = selected.has(g.grp);
          return (
            <Card key={g.grp} className={cn('flex flex-col gap-2 p-3', isSel && 'ring-2 ring-emerald-400')}>
              <div className="flex items-start gap-2">
                <button onClick={() => toggleOne(g.grp)} className="mt-0.5 shrink-0 text-zinc-400 hover:text-emerald-500" aria-label={t('artikel.select')}>
                  {isSel ? <CheckSquare size={18} className="text-emerald-500" /> : <Square size={18} />}
                </button>
                {value && <CanonicalIcon name={value} size={28} />}
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-zinc-400">{t('queue.ocr')}</div>
                  <div className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">{g.original_text ?? g.ai_guess ?? '–'}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {g.occurrences > 1 && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {t('queue.times', { count: g.occurrences })}
                    </span>
                  )}
                  {g.confidence && <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', confColor(g.confidence))}>{g.confidence}</span>}
                  {g.einkauf_id && (
                    <Link
                      to={`/receipts/${g.einkauf_id}${g.sample_artikel_id ? `?highlight=${g.sample_artikel_id}` : ''}`}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400"
                      title={t('queue.openReceipt')}
                    >
                      <ReceiptText size={13} /> #{g.einkauf_id}
                    </Link>
                  )}
                </div>
              </div>
              <Input value={value} onChange={e => setEdits(prev => ({ ...prev, [g.grp]: e.target.value }))} placeholder={t('queue.proposed')} />
              <div className="flex flex-wrap gap-2">
                <Button className="min-w-[6rem] flex-1" disabled={!value.trim()} onClick={() => decide.mutate({ artikel_ids: g.artikel_ids, canonical: value.trim(), action: 'approve' })}>{t('queue.approve')}</Button>
                <Button variant="ghost" className="min-w-[5rem]" onClick={() => decide.mutate({ artikel_ids: g.artikel_ids, action: 'reject' })}>{t('queue.reject')}</Button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* sticky bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 mx-auto flex max-w-2xl items-center gap-2 rounded-2xl border border-zinc-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 md:bottom-4">
          <span className="text-sm font-medium">{selected.size} {t('artikel.selected')}</span>
          <div className="ml-auto flex flex-wrap justify-end gap-1.5">
            <Button className="px-2.5" title={t('queue.approve')} aria-label={t('queue.approve')} onClick={bulkApprove} disabled={decideBulk.isPending}>
              <Check size={16} />
            </Button>
            <Button variant="secondary" className="px-2.5" title={t('queue.reject')} aria-label={t('queue.reject')} onClick={bulkReject} disabled={decideBulk.isPending}>
              <Ban size={16} />
            </Button>
            <Button variant="ghost" className="px-2.5" title={t('common.cancel')} aria-label={t('common.cancel')} onClick={() => setSelected(new Set())}>
              <X size={16} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
