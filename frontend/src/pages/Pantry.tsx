import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { api } from '../api/client';
import type { PantryItem } from '../api/types';
import { Card, Spinner, EmptyState, Badge } from '../components/ui';
import { cn, fmtDate } from '../lib/utils';

export function Pantry() {
  const { t, i18n } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['pantry'],
    queryFn: () => api<PantryItem[]>('/api/pantry'),
  });

  if (isLoading) return <Spinner />;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-bold">{t('pantry.title')}</h1>
      {!data?.length && <EmptyState>{t('pantry.empty')}</EmptyState>}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map(p => {
          const days = p.days_until_empty !== null ? Number(p.days_until_empty) : null;
          const critical = days !== null && days <= 3;
          const warn = days !== null && days <= 7 && !critical;
          return (
            <Card key={p.canonical_name} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{p.canonical_name}</span>
                {days !== null && (
                  <Badge className={cn(
                    critical && 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400',
                    warn && 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
                  )}>
                    {critical && <TriangleAlert size={11} />}
                    {Math.max(Math.round(days), 0)} {t('pantry.daysLeft')}
                  </Badge>
                )}
              </div>
              <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {p.est_remaining !== null && (
                  <span>{t('pantry.remaining')}: {Number(p.est_remaining).toFixed(1)} {p.einheit ?? ''} · </span>
                )}
                {t('pantry.lastBought')}: {fmtDate(p.last_bought, i18n.language)}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
