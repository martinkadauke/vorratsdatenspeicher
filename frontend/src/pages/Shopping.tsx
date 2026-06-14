import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2, Search } from 'lucide-react';
import { api } from '../api/client';
import type { ShoppingItem } from '../api/types';
import { Card, Spinner, EmptyState, Button, Input, Badge } from '../components/ui';
import { toast } from '../components/Toast';
import { cn, eur } from '../lib/utils';

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
  const nameSet = new Set((names ?? []).map(n => n.canonical_name));

  const [title, setTitle] = useState('');
  const [menge, setMenge] = useState('');
  // Local order preserved across refetches (so a drag isn't undone by a refresh).
  const [items, setItems] = useState<ShoppingItem[]>([]);
  useEffect(() => {
    setItems(prev => {
      const server = data ?? [];
      const serverIds = server.map(x => x.id).sort((a, b) => a - b).join(',');
      const localIds = prev.map(x => x.id).sort((a, b) => a - b).join(',');
      if (serverIds !== localIds) return server;            // add/remove → take server order
      const byId = new Map(server.map(s => [s.id, s]));
      return prev.map(p => byId.get(p.id) ?? p);            // same set → keep local order, refresh data
    });
  }, [data]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['shopping'] });
    void qc.invalidateQueries({ queryKey: ['shopping-list-mini'] });
  };

  const add = useMutation({
    mutationFn: () => {
      const ti = title.trim();
      return api('/api/shopping-list', {
        method: 'POST',
        body: { canonical_name: nameSet.has(ti) ? ti : null, title: ti, menge: menge.trim() ? num(menge) : null },
      });
    },
    onSuccess: () => { setTitle(''); setMenge(''); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const patchMenge = useMutation({
    mutationFn: ({ id, menge }: { id: number; menge: number | null }) =>
      api(`/api/shopping-list/${id}`, { method: 'PATCH', body: { menge } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shopping'] }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/shopping-list/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
  const persistOrder = useMutation({
    mutationFn: (order: number[]) => api('/api/shopping-list/order', { method: 'PUT', body: { order } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shopping'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setItems(prev => {
      const next = arrayMove(prev, prev.findIndex(x => x.id === active.id), prev.findIndex(x => x.id === over.id));
      persistOrder.mutate(next.map(x => x.id));
      return next;
    });
  };

  if (isLoading) return <Spinner />;

  const total = items.reduce((s, i) => s + (i.expected_price ?? 0), 0);
  const canAdd = title.trim().length > 0 && !add.isPending;

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h1 className="text-lg font-bold">{t('shopping.title')}</h1>

      {/* Add: title (typeahead + free-text) · optional menge */}
      <form
        onSubmit={e => { e.preventDefault(); if (canAdd) add.mutate(); }}
        className="flex gap-2 rounded-xl border border-zinc-200 p-2.5 dark:border-zinc-800"
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
        <div className="w-20 shrink-0">
          <Input inputMode="decimal" value={menge} onChange={e => setMenge(e.target.value)} placeholder={t('shopping.qty')} />
        </div>
        <Button type="submit" disabled={!canAdd} className="shrink-0"><Plus size={16} /></Button>
      </form>

      {!items.length && <EmptyState>{t('shopping.empty')}</EmptyState>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {items.map(s => (
              <ShoppingRow
                key={s.id}
                s={s}
                t={t}
                onMenge={(m) => patchMenge.mutate({ id: s.id, menge: m })}
                onRemove={() => remove.mutate(s.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {total > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <span className="font-medium text-zinc-500 dark:text-zinc-400">{t('shopping.expectedTotal')}</span>
          <span className="tabular text-base font-bold">{eur(total)}</span>
        </div>
      )}
    </div>
  );
}

function ShoppingRow({ s, t, onMenge, onRemove }: {
  s: ShoppingItem; t: TFunction; onMenge: (m: number | null) => void; onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const style = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined };
  return (
    <div ref={setNodeRef} style={style}>
      <Card className={cn('flex items-center gap-2 px-1.5 py-2.5 sm:gap-2.5 sm:px-2.5',
        isDragging && 'opacity-80 shadow-lg ring-2 ring-emerald-400')}
      >
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Verschieben"
          className="shrink-0 cursor-grab touch-none rounded-md p-1 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:bg-zinc-800"
        >
          <GripVertical size={16} />
        </button>
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
        <div className="flex shrink-0 items-center gap-1">
          <div className="w-16">
            <Input
              key={`m${s.id}`}
              className="text-right"
              inputMode="decimal"
              defaultValue={s.menge ?? ''}
              placeholder={t('shopping.qty')}
              onBlur={e => {
                const raw = e.target.value.trim();
                const v = num(raw);
                if (raw && v !== s.menge) onMenge(v);
              }}
            />
          </div>
          {s.avg_unit && <span className="w-8 shrink-0 text-xs text-zinc-400">{s.avg_unit}</span>}
        </div>
        <button
          type="button"
          onClick={onRemove}
          title={t('shopping.remove')}
          className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
        >
          <Trash2 size={16} />
        </button>
      </Card>
    </div>
  );
}
