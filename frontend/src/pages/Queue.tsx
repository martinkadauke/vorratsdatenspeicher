import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ReceiptText, Search, X, CheckSquare, Square, Check, Ban, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { QueueItem } from '../api/types';
import { Card, Spinner, EmptyState, Button, Input, Select } from '../components/ui';
import { CanonicalIcon } from '../components/IconPicker';
import { FirstVisitHint } from '../components/FirstVisitHint';
import { toast } from '../components/Toast';
import { cn } from '../lib/utils';

type Sort = 'confidence' | 'confidence_desc' | 'date' | 'alpha';

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
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('confidence');
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ['queue', search, sort],
    queryFn: () => api<{ items: QueueItem[]; total: number }>(`/api/queue?q=${encodeURIComponent(search)}&sort=${sort}`),
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['queue'] });
    void qc.invalidateQueries({ queryKey: ['names'] });
    void qc.invalidateQueries({ queryKey: ['artikel-list'] });
  };

  const decide = useMutation({
    mutationFn: ({ id, action, final }: { id: number; action: string; final?: string }) =>
      api('/api/queue/decide', { method: 'POST', body: { id, action, final_canonical: final } }),
    onSuccess: invalidate,
  });
  const decideBulk = useMutation({
    mutationFn: ({ ids, action }: { ids: number[]; action: string }) =>
      api<{ count: number }>('/api/queue/decide-bulk', { method: 'POST', body: { ids, action } }),
    onSuccess: (r) => { invalidate(); setSelected(new Set()); toast(t('queue.bulkDone', { count: r.count }), 'success'); },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  // keyboard: F → focus search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.key.toLowerCase() === 'f') { e.preventDefault(); document.getElementById('queue-search')?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const allSelected = items.length > 0 && items.every(q => selected.has(q.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map(q => q.id)));
  const toggleOne = (id: number) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <div className="flex flex-col gap-3 pb-20">
      <h1 className="text-lg font-bold">{t('queue.title')}</h1>
      <FirstVisitHint id="queue1" titleKey="hint.queue.title" bodyKey="hint.queue.body" />

      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input id="queue-search" className="pl-9 pr-9" placeholder={t('queue.search')} title="[F]" value={search} onChange={e => setSearch(e.target.value)} />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={15} />
          </button>
        )}
      </div>

      <Select value={sort} onChange={e => setSort(e.target.value as Sort)}>
        <option value="confidence">{t('queue.sortConfidenceAsc')}</option>
        <option value="confidence_desc">{t('queue.sortConfidenceDesc')}</option>
        <option value="date">{t('queue.sortDate')}</option>
        <option value="alpha">{t('queue.sortAlpha')}</option>
      </Select>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <button onClick={toggleAll} className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {allSelected ? <CheckSquare size={15} className="text-emerald-500" /> : <Square size={15} />} {t('artikel.selectAll')}
        </button>
        <span>
          {t('queue.countOpen', { count: total })}
          {items.length < total ? ` · ${t('queue.showing', { n: items.length })}` : ''}
        </span>
      </div>

      {isLoading && <Spinner />}
      {!isLoading && !items.length && <EmptyState>{search ? '–' : t('queue.empty')}</EmptyState>}

      <div className="flex flex-col gap-2">
        {items.map(q => {
          const value = edits[q.id] ?? q.proposed_canonical ?? '';
          const isSel = selected.has(q.id);
          return (
            <Card key={q.id} className={cn('flex flex-col gap-2 p-3', isSel && 'ring-2 ring-emerald-400')}>
              <div className="flex items-start gap-2">
                <button onClick={() => toggleOne(q.id)} className="mt-0.5 shrink-0 text-zinc-400 hover:text-emerald-500" aria-label={t('artikel.select')}>
                  {isSel ? <CheckSquare size={18} className="text-emerald-500" /> : <Square size={18} />}
                </button>
                {q.proposed_canonical && <CanonicalIcon name={q.proposed_canonical} size={28} />}
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-zinc-400">{t('queue.ocr')}</div>
                  <div className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">{q.raw_patterns ?? q.ai_examples ?? '–'}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {q.confidence && <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', confColor(q.confidence))}>{q.confidence}</span>}
                  {q.einkauf_id && (
                    <Link
                      to={`/receipts/${q.einkauf_id}${q.artikel_id ? `?highlight=${q.artikel_id}` : ''}`}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400"
                      title={t('queue.openReceipt')}
                    >
                      <ReceiptText size={13} /> #{q.einkauf_id}
                    </Link>
                  )}
                </div>
              </div>
              <Input value={value} onChange={e => setEdits(prev => ({ ...prev, [q.id]: e.target.value }))} placeholder={t('queue.proposed')} />
              <div className="flex flex-wrap gap-2">
                <Button className="min-w-[6rem] flex-1" disabled={!value} onClick={() => decide.mutate({ id: q.id, action: 'approve', final: value })}>{t('queue.approve')}</Button>
                <Button variant="secondary" className="min-w-[5rem]" onClick={() => decide.mutate({ id: q.id, action: 'reject' })}>{t('queue.reject')}</Button>
                <Button variant="ghost" className="min-w-[5rem]" onClick={() => decide.mutate({ id: q.id, action: 'remove' })}>{t('queue.remove')}</Button>
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
            <Button className="px-2.5" title={t('queue.approve')} aria-label={t('queue.approve')} onClick={() => decideBulk.mutate({ ids: [...selected], action: 'approve' })} disabled={decideBulk.isPending}>
              <Check size={16} />
            </Button>
            <Button variant="secondary" className="px-2.5" title={t('queue.reject')} aria-label={t('queue.reject')} onClick={() => decideBulk.mutate({ ids: [...selected], action: 'reject' })} disabled={decideBulk.isPending}>
              <Ban size={16} />
            </Button>
            <Button variant="secondary" className="px-2.5" title={t('queue.remove')} aria-label={t('queue.remove')} onClick={() => decideBulk.mutate({ ids: [...selected], action: 'remove' })} disabled={decideBulk.isPending}>
              <Trash2 size={16} />
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
