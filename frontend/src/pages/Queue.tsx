import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ReceiptText } from 'lucide-react';
import { api } from '../api/client';
import type { QueueItem } from '../api/types';
import { Card, Spinner, EmptyState, Button, Input, Badge } from '../components/ui';

export function Queue() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<number, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['queue'],
    queryFn: () => api<QueueItem[]>('/api/queue'),
  });

  const decide = useMutation({
    mutationFn: ({ id, action, final }: { id: number; action: string; final?: string }) =>
      api('/api/queue/decide', { method: 'POST', body: { id, action, final_canonical: final } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['queue'] });
      void qc.invalidateQueries({ queryKey: ['names'] });
    },
  });

  if (isLoading) return <Spinner />;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-bold">{t('queue.title')}</h1>
      {!data?.length && <EmptyState>{t('queue.empty')}</EmptyState>}
      <div className="flex flex-col gap-2">
        {data?.map(q => {
          const value = edits[q.id] ?? q.proposed_canonical ?? '';
          return (
            <Card key={q.id} className="flex flex-col gap-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-zinc-400">{t('queue.ocr')}</div>
                  <div className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">
                    {q.raw_patterns ?? q.ai_examples ?? '–'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {q.einkauf_id && (
                    <Link
                      to={`/receipts/${q.einkauf_id}${q.artikel_id ? `?highlight=${q.artikel_id}` : ''}`}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400"
                      title={t('queue.openReceipt')}
                    >
                      <ReceiptText size={13} /> #{q.einkauf_id}
                    </Link>
                  )}
                  {q.confidence && (
                    <Badge>{t('queue.confidence')}: {q.confidence}</Badge>
                  )}
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs text-zinc-400">{t('queue.proposed')} — {t('queue.editHint')}</div>
                <Input
                  value={value}
                  onChange={e => setEdits(prev => ({ ...prev, [q.id]: e.target.value }))}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  className="flex-1 min-w-[6rem]"
                  disabled={!value}
                  onClick={() => decide.mutate({ id: q.id, action: 'approve', final: value })}
                >
                  {t('queue.approve')}
                </Button>
                <Button variant="secondary" className="min-w-[5rem]" onClick={() => decide.mutate({ id: q.id, action: 'reject' })}>
                  {t('queue.reject')}
                </Button>
                <Button variant="ghost" className="min-w-[5rem]" onClick={() => decide.mutate({ id: q.id, action: 'remove' })}>
                  {t('queue.remove')}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
