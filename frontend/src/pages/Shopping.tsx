import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Clock, Ban } from 'lucide-react';
import { api } from '../api/client';
import type { ShoppingItem } from '../api/types';
import { Card, Spinner, EmptyState, Button, Badge } from '../components/ui';

export function Shopping() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['shopping'],
    queryFn: () => api<ShoppingItem[]>('/api/shopping-list'),
  });

  const feedback = useMutation({
    mutationFn: ({ action, name }: { action: string; name: string }) =>
      api('/api/shopping-list/feedback', { method: 'POST', body: { action, canonical_name: name, snooze_days: 7 } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shopping'] }),
  });

  if (isLoading) return <Spinner />;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-bold">{t('shopping.title')}</h1>
      {!data?.length && <EmptyState>{t('shopping.empty')}</EmptyState>}
      <div className="flex flex-col gap-2">
        {data?.map(s => (
          <Card key={s.canonical_name} className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{s.canonical_name}</div>
              <div className="mt-0.5 flex flex-wrap gap-1 text-xs text-zinc-500">
                {s.days_until_empty !== null && (
                  <Badge>{Math.max(Math.round(Number(s.days_until_empty)), 0)} {t('pantry.daysLeft')}</Badge>
                )}
                {s.est_remaining !== null && (
                  <span>{Number(s.est_remaining).toFixed(1)} {s.einheit ?? ''}</span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button variant="primary" className="px-2.5" title={t('shopping.done')}
                onClick={() => feedback.mutate({ action: 'done', name: s.canonical_name })}>
                <Check size={16} />
              </Button>
              <Button variant="secondary" className="px-2.5" title={t('shopping.snooze')}
                onClick={() => feedback.mutate({ action: 'snooze', name: s.canonical_name })}>
                <Clock size={16} />
              </Button>
              <Button variant="ghost" className="px-2.5" title={t('shopping.exclude')}
                onClick={() => feedback.mutate({ action: 'exclude', name: s.canonical_name })}>
                <Ban size={16} />
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
