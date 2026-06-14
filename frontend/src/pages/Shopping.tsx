import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Search } from 'lucide-react';
import { api } from '../api/client';
import type { ShoppingItem } from '../api/types';
import { Card, Spinner, EmptyState, Button, Input, Badge } from '../components/ui';
import { toast } from '../components/Toast';
import { eur } from '../lib/utils';

const num = (s: string): number | null => {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

export function Shopping() {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['shopping'],
    queryFn: () => api<ShoppingItem[]>('/api/shopping-list'),
  });
  // Canonical names → typeahead suggestions (free text is still allowed).
  const { data: names } = useQuery({
    queryKey: ['names-mini'],
    queryFn: () => api<{ canonical_name: string }[]>('/api/names'),
    staleTime: 60_000,
  });
  const nameSet = useMemo(() => new Set((names ?? []).map(n => n.canonical_name)), [names]);

  const [title, setTitle] = useState('');
  const [menge, setMenge] = useState('');
  const [einheit, setEinheit] = useState('');

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['shopping'] });
    void qc.invalidateQueries({ queryKey: ['shopping-list-mini'] });
  };

  const add = useMutation({
    mutationFn: () => {
      const ti = title.trim();
      return api('/api/shopping-list', {
        method: 'POST',
        body: {
          canonical_name: nameSet.has(ti) ? ti : null, // exact match → known product, else free-text
          title: ti,
          menge: menge.trim() ? num(menge) : null,
          einheit: einheit.trim() || null,
        },
      });
    },
    onSuccess: () => { setTitle(''); setMenge(''); setEinheit(''); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api(`/api/shopping-list/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shopping'] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/shopping-list/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  if (isLoading) return <Spinner />;

  const items = data ?? [];
  const total = items.reduce((s, i) => s + (i.expected_price ?? 0), 0);
  const canAdd = title.trim().length > 0 && !add.isPending;

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h1 className="text-lg font-bold">{t('shopping.title')}</h1>

      {/* Add: title (typeahead + free-text) · optional menge · optional einheit */}
      <form
        onSubmit={e => { e.preventDefault(); if (canAdd) add.mutate(); }}
        className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-2.5 dark:border-zinc-800 sm:flex-row sm:items-center"
      >
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input
            list="shopping-canon"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={t('shopping.addPlaceholder')}
            className="pl-8"
          />
          <datalist id="shopping-canon">
            {(names ?? []).map(n => <option key={n.canonical_name} value={n.canonical_name} />)}
          </datalist>
        </div>
        <div className="flex gap-2">
          <div className="w-20 shrink-0">
            <Input inputMode="decimal" value={menge} onChange={e => setMenge(e.target.value)} placeholder={t('shopping.qty')} />
          </div>
          <div className="w-20 shrink-0">
            <Input value={einheit} onChange={e => setEinheit(e.target.value)} placeholder={t('shopping.unit')} />
          </div>
          <Button type="submit" disabled={!canAdd} className="shrink-0"><Plus size={16} /></Button>
        </div>
      </form>

      {!items.length && <EmptyState>{t('shopping.empty')}</EmptyState>}

      <div className="flex flex-col gap-1.5">
        {items.map(s => (
          <Card key={s.id} className="flex items-center gap-2 p-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{s.title}</span>
                {s.canonical_name == null && <Badge>{t('shopping.freeText')}</Badge>}
                {s.source === 'suggested' && <Badge>{t('shopping.suggested')}</Badge>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                {s.avg_price != null && s.avg_unit && <span>Ø {eur(s.avg_price)}/{s.avg_unit}</span>}
                {s.expected_price != null && (
                  <span className="font-semibold text-emerald-600 dark:text-emerald-500">≈ {eur(s.expected_price)}</span>
                )}
              </div>
            </div>
            <div className="w-16 shrink-0">
              <Input
                key={`m${s.id}`}
                className="text-right"
                inputMode="decimal"
                defaultValue={s.menge ?? ''}
                placeholder={t('shopping.qty')}
                onBlur={e => { const v = num(e.target.value.trim()); if (e.target.value.trim() && v !== s.menge) patch.mutate({ id: s.id, body: { menge: v } }); }}
              />
            </div>
            <div className="w-16 shrink-0">
              <Input
                key={`u${s.id}`}
                defaultValue={s.einheit ?? ''}
                placeholder={t('shopping.unit')}
                onBlur={e => { const v = e.target.value.trim(); if (v !== (s.einheit ?? '')) patch.mutate({ id: s.id, body: { einheit: v || null } }); }}
              />
            </div>
            <button
              type="button"
              onClick={() => remove.mutate(s.id)}
              title={t('shopping.remove')}
              className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
            >
              <Trash2 size={16} />
            </button>
          </Card>
        ))}
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <span className="font-medium text-zinc-500 dark:text-zinc-400">{t('shopping.expectedTotal')}</span>
          <span className="tabular text-base font-bold">{eur(total)}</span>
        </div>
      )}
    </div>
  );
}
