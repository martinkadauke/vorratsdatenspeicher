import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { api } from '../api/client';
import type { Receipt } from '../api/types';
import { Card, Input, Spinner, EmptyState, Button } from '../components/ui';
import { cn, eur, fmtDate } from '../lib/utils';

interface Store { key: string; display: string; receipts: number; total: number; raw: string[] }

export function Receipts() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const [limit, setLimit] = useState(50);

  const { data: stores } = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<Store[]>('/api/stores'),
    staleTime: 60_000,
  });

  const storeParam = storeFilter ? `&store=${encodeURIComponent(storeFilter)}` : '';
  const { data, isLoading } = useQuery({
    queryKey: ['receipts', search, storeFilter, limit],
    queryFn: () => api<Receipt[]>(`/api/receipts?limit=${limit}&q=${encodeURIComponent(search)}${storeParam}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input
          className="pl-9"
          placeholder={t('receipts.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {stores && stores.length > 1 && (
        <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1">
          <button
            onClick={() => setStoreFilter(null)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1 text-xs font-medium',
              storeFilter === null
                ? 'border-transparent bg-emerald-600 text-white'
                : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
            )}
          >
            {t('receipts.allStores')}
          </button>
          {stores.slice(0, 12).map(s => (
            <button
              key={s.key}
              onClick={() => setStoreFilter(storeFilter === s.key ? null : s.key)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1 text-xs font-medium',
                storeFilter === s.key
                  ? 'border-transparent bg-emerald-600 text-white'
                  : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
              )}
            >
              {s.display} <span className="opacity-60">·{s.receipts}</span>
            </button>
          ))}
        </div>
      )}

      {isLoading && <Spinner />}
      {!isLoading && !data?.length && <EmptyState>{t('receipts.empty')}</EmptyState>}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map(r => (
          <Card key={r.id} onClick={() => navigate(`/receipts/${r.id}`)} className="flex items-center gap-3 p-3">
            {r.bild_pfad ? (
              <img
                src={r.bild_pfad}
                alt=""
                loading="lazy"
                className="h-16 w-12 shrink-0 rounded-lg border border-zinc-200 object-cover dark:border-zinc-700"
              />
            ) : (
              <div className="flex h-16 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-lg dark:bg-zinc-800">
                🧾
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{r.roh_ladenname ?? '?'}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {fmtDate(r.datum, i18n.language)} · {r.item_count} {t('receipts.items')}
              </div>
              <div className="tabular mt-0.5 font-semibold text-emerald-600 dark:text-emerald-500">
                {eur(r.gesamt_betrag)}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {(data?.length ?? 0) >= limit && (
        <Button variant="secondary" onClick={() => setLimit(l => l + 50)}>
          {t('receipts.loadMore')}
        </Button>
      )}
    </div>
  );
}
