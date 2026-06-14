import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { TriangleAlert, Pencil, RotateCcw, Check, X } from 'lucide-react';
import { api } from '../api/client';
import type { PantryItem } from '../api/types';
import { Card, Spinner, EmptyState, Badge, Input, Button } from '../components/ui';
import { CanonicalIcon } from '../components/IconPicker';
import { toast } from '../components/Toast';
import { cn, fmtDate } from '../lib/utils';

const num = (s: string): number | null => { const n = parseFloat(s.replace(',', '.')); return Number.isFinite(n) ? n : null; };
const fmtQty = (n: number | null): string => n == null ? '–' : (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

export function Pantry() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['pantry'], queryFn: () => api<PantryItem[]>('/api/pantry') });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const setOverride = useMutation({
    mutationFn: ({ name, menge }: { name: string; menge: number }) =>
      api(`/api/pantry/${encodeURIComponent(name)}/override`, { method: 'PUT', body: { menge } }),
    onSuccess: () => { setEditing(null); void qc.invalidateQueries({ queryKey: ['pantry'] }); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const clearOverride = useMutation({
    mutationFn: (name: string) => api(`/api/pantry/${encodeURIComponent(name)}/override`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pantry'] }),
  });

  const commit = (name: string) => { const v = num(draft); if (v != null) setOverride.mutate({ name, menge: Math.max(0, v) }); };

  if (isLoading) return <Spinner />;
  const items = data ?? [];

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h1 className="text-lg font-bold">{t('pantry.title')}</h1>
      {!items.length && <EmptyState>{t('pantry.emptyTracked')}</EmptyState>}
      <div className="flex flex-col gap-2">
        {items.map(p => {
          const days = p.days_until_empty;
          const critical = days != null && days <= 3;
          const warn = days != null && days > 3 && days <= 7;
          const remaining = p.est_remaining != null ? Math.max(0, p.est_remaining) : null;
          const belowReserve = p.reserve_min != null && p.est_remaining != null && p.est_remaining <= p.reserve_min;
          const isEditing = editing === p.canonical_name;
          return (
            <Card key={p.canonical_name} className="flex items-center gap-3 p-3">
              <CanonicalIcon name={p.canonical_name} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium">{p.canonical_name}</span>
                  {belowReserve && (
                    <Badge className="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400">
                      <TriangleAlert size={11} /> {t('pantry.belowReserve')}
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{fmtQty(remaining)} {p.base_unit}</span>
                  {days != null && (
                    <Badge className={cn(
                      critical && 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400',
                      warn && 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400',
                    )}>
                      {Math.max(Math.round(days), 0)} {t('pantry.daysLeft')}
                    </Badge>
                  )}
                  {p.override
                    ? <span title={fmtDate(p.override.gesetzt_am, i18n.language)}>· {t('pantry.corrected')}</span>
                    : p.last_bought && <span>· {t('pantry.lastBought')}: {fmtDate(p.last_bought, i18n.language)}</span>}
                </div>
                {isEditing && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="w-24">
                      <Input
                        autoFocus inputMode="decimal" value={draft} placeholder={t('pantry.realQty')}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') commit(p.canonical_name); if (e.key === 'Escape') setEditing(null); }}
                      />
                    </div>
                    <span className="text-xs text-zinc-400">{p.base_unit}</span>
                    <Button className="px-2.5" onClick={() => commit(p.canonical_name)}><Check size={15} /></Button>
                    <button type="button" onClick={() => setEditing(null)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={15} /></button>
                  </div>
                )}
              </div>
              {!isEditing && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { setDraft(remaining != null ? fmtQty(remaining) : ''); setEditing(p.canonical_name); }}
                    title={t('pantry.correct')}
                    className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                  >
                    <Pencil size={15} />
                  </button>
                  {p.override && (
                    <button
                      type="button"
                      onClick={() => clearOverride.mutate(p.canonical_name)}
                      title={t('pantry.resetOverride')}
                      className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                    >
                      <RotateCcw size={15} />
                    </button>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
