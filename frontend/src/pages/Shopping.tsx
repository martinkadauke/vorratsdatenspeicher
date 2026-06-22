import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { GripVertical, Minus, Plus, Trash2, Search, Sparkles, BarChart3, Send, TrendingDown, MessageSquare, CheckSquare, Square, ClipboardList, ShoppingBag } from 'lucide-react';
import { api } from '../api/client';
import type { ShoppingItem } from '../api/types';
import { Card, Spinner, EmptyState, Button, Input, Badge } from '../components/ui';
import { CanonicalIcon } from '../components/IconPicker';
import { toast } from '../components/Toast';
import { cn, eur } from '../lib/utils';

interface StoreItem { id: number; canonical_name: string | null; title: string; menge: number; category: string | null; price: number | null; unit: string | null; source: string | null; expected: number | null; carried: boolean; cheapest: boolean }
interface StoreList { chain_key: string; store: string; item_count: number; total: number; items: StoreItem[] }

const num = (s: string): number | null => {
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : String(n).replace('.', ','));

export function Shopping() {
  const { t, i18n } = useTranslation();
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
        body: { canonical_name: nameSet.has(ti) ? ti : null, title: ti },
      });
    },
    onSuccess: () => { setTitle(''); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const patchMenge = useMutation({
    mutationFn: ({ id, menge }: { id: number; menge: number | null }) =>
      api(`/api/shopping-list/${id}`, { method: 'PATCH', body: { menge } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shopping'] }),
  });
  const patchComment = useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) =>
      api(`/api/shopping-list/${id}`, { method: 'PATCH', body: { comment } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shopping'] }),
  });

  // Einkaufszettel (shopping trip) state
  const { data: session } = useQuery({
    queryKey: ['shopping-session'],
    queryFn: () => api<{ active: boolean; created_at: string | null }>('/api/shopping-list/session'),
  });
  const sessionActive = !!session?.active;
  const patchDone = useMutation({
    mutationFn: ({ id, done }: { id: number; done: boolean }) =>
      api(`/api/shopping-list/${id}`, { method: 'PATCH', body: { done } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shopping'] }),
  });
  const startSession = useMutation({
    mutationFn: () => api('/api/shopping-list/session/start', { method: 'POST' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['shopping-session'] }); invalidate(); },
  });
  const finishSession = useMutation({
    mutationFn: () => api<{ removed: number }>('/api/shopping-list/session/finish', { method: 'POST' }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['shopping-session'] });
      invalidate();
      toast(t('shopping.tripDone', { count: r.removed }), 'success');
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/shopping-list/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
  const suggest = useMutation({
    mutationFn: () => api<{ added: number }>('/api/shopping-list/suggest', { method: 'POST' }),
    onSuccess: (r) => { invalidate(); toast(r.added ? t('shopping.suggestionsAdded', { count: r.added }) : t('shopping.noSuggestions'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const [comparing, setComparing] = useState(false);
  const [byStore, setByStore] = useState<StoreList[] | null>(null);
  const [activeChain, setActiveChain] = useState<string | null>(null);
  const runCompare = async () => {
    setComparing(true);
    try {
      await api('/api/shopping-list/compare', { method: 'POST' }); // register watches for the next offer refresh
      const res = await api<{ chains: StoreList[] }>('/api/shopping-list/by-store');
      setByStore(res.chains);
      setActiveChain(res.chains[0]?.chain_key ?? null);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setComparing(false); }
  };

  const send = useMutation({
    mutationFn: () => api<{ emailed: number; notified: number; smtp: boolean }>('/api/shopping-list/send', { method: 'POST' }),
    onSuccess: (r) => toast(r.smtp ? t('shopping.sent', { count: r.emailed }) : t('shopping.sentNoSmtp', { count: r.notified }), 'success'),
    onError: (e: Error) => toast(e.message, 'error'),
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold">{t('shopping.title')}</h1>
        <div className="flex flex-wrap gap-2">
          {!sessionActive && (
            <Button onClick={() => startSession.mutate()} disabled={startSession.isPending || !items.length} className="shrink-0">
              <ClipboardList size={15} /> {t('shopping.startTrip')}
            </Button>
          )}
          <Button variant="secondary" onClick={() => suggest.mutate()} disabled={suggest.isPending} className="shrink-0">
            <Sparkles size={15} /> {t('shopping.getSuggestions')}
          </Button>
          <Button variant="secondary" onClick={runCompare} disabled={comparing} className="shrink-0">
            <BarChart3 size={15} /> {comparing ? t('shopping.comparing') : t('shopping.compareOffers')}
          </Button>
          <Button variant="secondary" onClick={() => send.mutate()} disabled={send.isPending} className="shrink-0">
            <Send size={15} /> {t('shopping.send')}
          </Button>
        </div>
      </div>

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
        <Button type="submit" disabled={!canAdd} className="shrink-0"><Plus size={16} /></Button>
      </form>

      {sessionActive && session?.created_at && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <ShoppingBag size={15} className="shrink-0" />
          <span>{t('shopping.tripSince', { date: new Date(session.created_at).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'de-DE') })}</span>
        </div>
      )}

      {!items.length && <EmptyState>{t('shopping.empty')}</EmptyState>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {items.map(s => (
              <ShoppingRow
                key={s.id}
                s={s}
                t={t}
                sessionActive={sessionActive}
                onMenge={(m) => patchMenge.mutate({ id: s.id, menge: m })}
                onComment={(c) => patchComment.mutate({ id: s.id, comment: c })}
                onToggleDone={() => patchDone.mutate({ id: s.id, done: !s.done })}
                onRemove={() => remove.mutate(s.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {sessionActive && (
        <Button onClick={() => finishSession.mutate()} disabled={finishSession.isPending} className="w-full justify-center">
          <ShoppingBag size={16} /> {t('shopping.finishTrip')}
        </Button>
      )}

      {total > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <span className="font-medium text-zinc-500 dark:text-zinc-400">{t('shopping.expectedTotal')}</span>
          <span className="tabular text-base font-bold">{eur(total)}</span>
        </div>
      )}

      {byStore && (
        <div className="mt-1 flex flex-col gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <div className="flex items-center gap-2"><BarChart3 size={16} className="text-violet-500" /><h2 className="text-sm font-bold">{t('shopping.byStore')}</h2></div>
          {!byStore.length && <EmptyState>{t('shopping.noStores')}</EmptyState>}
          {byStore.length > 0 && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {byStore.map(c => (
                  <button
                    key={c.chain_key} type="button" onClick={() => setActiveChain(c.chain_key)}
                    className={cn('rounded-full border px-3 py-1 text-xs font-medium',
                      c.chain_key === activeChain ? 'border-transparent bg-violet-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}
                  >
                    {c.store} · {c.item_count} · {eur(c.total)}
                  </button>
                ))}
              </div>
              {byStore.filter(c => c.chain_key === activeChain).map(c => (
                <Card key={c.chain_key} className="flex flex-col divide-y divide-zinc-100 p-0 dark:divide-zinc-800">
                  {c.items.map(it => (
                    <div key={it.id} className={cn('flex items-center gap-2 px-3 py-2', !it.carried && 'opacity-45')}>
                      {it.canonical_name ? <CanonicalIcon name={it.canonical_name} size={26} /> : <span className="h-[26px] w-[26px] shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{fmt(it.menge)}× {it.title}</span>
                          {it.carried && it.cheapest && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400" aria-label={t('shopping.cheapest')}>
                              <TrendingDown size={11} />{t('shopping.cheapest')}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-400">
                          {it.carried
                            ? <>
                                {it.category && <span>{it.category.split('/').pop()}</span>}
                                {it.source && <span>· {t(`shopping.src.${it.source}`)}</span>}
                              </>
                            : <span className="italic">{t('shopping.notCarried')}</span>}
                        </div>
                      </div>
                      {!it.carried
                        ? <span className="shrink-0 text-base text-zinc-300 dark:text-zinc-600">—</span>
                        : it.expected != null
                          ? <span className="tabular shrink-0 text-sm font-semibold">{eur(it.expected)}</span>
                          : <span className="shrink-0 text-xs text-zinc-400">{t('shopping.noPrice')}</span>}
                    </div>
                  ))}
                  <div className="flex items-center justify-between px-3 py-2.5 text-sm font-bold">
                    <span>{t('shopping.expectedTotal')}</span><span className="tabular">{eur(c.total)}</span>
                  </div>
                </Card>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ShoppingRow({ s, t, sessionActive, onMenge, onComment, onToggleDone, onRemove }: {
  s: ShoppingItem; t: TFunction; sessionActive: boolean;
  onMenge: (m: number) => void; onComment: (c: string) => void; onToggleDone: () => void; onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  const style = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined };
  const navigate = useNavigate();
  const [commentOpen, setCommentOpen] = useState(false);
  const [draft, setDraft] = useState(s.comment ?? '');
  const hasComment = !!(s.comment && s.comment.trim());
  const done = sessionActive && s.done;

  // Checkbox: tap = toggle done, long-press (500ms) = remove the item.
  const held = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startHold = () => { held.current = false; holdTimer.current = setTimeout(() => { held.current = true; onRemove(); }, 500); };
  const cancelHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = undefined; } };
  const onCheckClick = () => { if (held.current) { held.current = false; return; } onToggleDone(); };

  const toggleComment = () => { setDraft(s.comment ?? ''); setCommentOpen(o => !o); };
  const saveComment = () => {
    setCommentOpen(false);
    const v = draft.trim();
    if (v !== (s.comment ?? '').trim()) onComment(v);   // '' clears it
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Card className={cn('flex flex-col gap-2 px-1.5 py-2.5 sm:px-2.5',
        isDragging && 'opacity-80 shadow-lg ring-2 ring-emerald-400')}
      >
        <div className="flex items-center gap-2 sm:gap-2.5">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label="Verschieben"
            className="shrink-0 cursor-grab touch-none rounded-md p-1 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:bg-zinc-800"
          >
            <GripVertical size={16} />
          </button>
          <div className={cn('min-w-0 flex-1', done && 'opacity-50')}>
            <div className="flex min-w-0 items-center gap-1.5">
              {s.canonical_name
                ? <button
                    type="button"
                    onPointerDown={e => e.stopPropagation()}
                    onClick={() => navigate(`/warenstamm/artikel?open=${encodeURIComponent(s.canonical_name!)}`)}
                    className={cn('truncate text-left font-medium hover:text-emerald-600 hover:underline dark:hover:text-emerald-400', done && 'line-through')}
                  >{s.title}</button>
                : <span className={cn('truncate font-medium', done && 'line-through')}>{s.title}</span>}
              {s.canonical_name == null && <Badge>{t('shopping.freeText')}</Badge>}
              {s.source === 'suggested' && <Sparkles size={12} className="shrink-0 text-amber-500" aria-label={t('shopping.suggested')} />}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
              {s.avg_price != null && s.avg_unit && <span>Ø {eur(s.avg_price)}/{s.avg_unit}</span>}
              {s.expected_price != null && (
                <span className="font-semibold text-emerald-600 dark:text-emerald-500">≈ {eur(s.expected_price)}</span>
              )}
              {hasComment && !commentOpen && <span className="truncate italic text-zinc-400">„{s.comment}"</span>}
            </div>
          </div>
          <MengeStepper value={s.menge ?? 1} unit={s.avg_unit} onChange={onMenge} t={t} />
          <button
            type="button"
            onClick={toggleComment}
            title={t('shopping.comment')}
            aria-label={t('shopping.comment')}
            className={cn('shrink-0 rounded-lg p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800',
              hasComment ? 'text-amber-500' : 'text-zinc-400')}
          >
            <MessageSquare size={16} />
          </button>
          {sessionActive ? (
            <button
              type="button"
              onPointerDown={e => { e.stopPropagation(); startHold(); }}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              onClick={onCheckClick}
              title={s.done ? t('shopping.uncheck') : t('shopping.check')}
              aria-label={s.done ? t('shopping.uncheck') : t('shopping.check')}
              className={cn('shrink-0 touch-none rounded-lg p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                s.done ? 'text-emerald-500' : 'text-zinc-400')}
            >
              {s.done ? <CheckSquare size={18} /> : <Square size={18} />}
            </button>
          ) : (
            <button
              type="button"
              onClick={onRemove}
              title={t('shopping.remove')}
              className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>

        {commentOpen && (
          <Input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={saveComment}
            onKeyDown={e => { if (e.key === 'Enter') saveComment(); if (e.key === 'Escape') setCommentOpen(false); }}
            placeholder={t('shopping.commentPlaceholder')}
            className="text-sm"
          />
        )}
      </Card>
    </div>
  );
}

/** Quantity stepper: − / value / + (step 1, floor 0). Long-press a button — or
 *  tap the value — to type an exact amount (e.g. 1,5). Defaults to one base-unit
 *  package; `unit` (kg/l/Stück) is shown next to the number. */
function MengeStepper({ value, unit, onChange, t }: {
  value: number; unit: string | null; onChange: (m: number) => void; t: TFunction;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const held = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const openEdit = () => { setDraft(fmt(value)); setEditing(true); };
  const startHold = () => { held.current = false; timer.current = setTimeout(() => { held.current = true; openEdit(); }, 450); };
  const cancelHold = () => { if (timer.current) { clearTimeout(timer.current); timer.current = undefined; } };
  const step = (delta: number) => () => {
    if (held.current) { held.current = false; return; } // long-press already opened the editor
    onChange(Math.max(0, Math.round((value + delta) * 100) / 100));
  };
  const commit = () => { setEditing(false); const n = num(draft); if (n != null && n !== value) onChange(Math.max(0, n)); };

  if (editing) {
    return (
      <div className="w-24 shrink-0">
        <Input
          autoFocus
          className="text-center"
          inputMode="decimal"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') setEditing(false); }}
        />
      </div>
    );
  }
  const btn = 'touch-none px-2 py-1.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800';
  return (
    <div className="flex shrink-0 select-none items-center rounded-lg border border-zinc-200 dark:border-zinc-700">
      <button type="button" aria-label="−" title={t('shopping.holdToType')}
        onPointerDown={startHold} onPointerUp={cancelHold} onPointerLeave={cancelHold}
        onClick={step(-1)} onContextMenu={e => e.preventDefault()} className={cn(btn, 'rounded-l-lg')}>
        <Minus size={14} />
      </button>
      <button type="button" onClick={openEdit} onContextMenu={e => e.preventDefault()} title={t('shopping.holdToType')}
        className="tabular min-w-[3rem] px-1 py-1.5 text-center text-sm font-medium">
        {fmt(value)}{unit && <span className="ml-0.5 text-xs font-normal text-zinc-400">{unit}</span>}
      </button>
      <button type="button" aria-label="+" title={t('shopping.holdToType')}
        onPointerDown={startHold} onPointerUp={cancelHold} onPointerLeave={cancelHold}
        onClick={step(1)} onContextMenu={e => e.preventDefault()} className={cn(btn, 'rounded-r-lg')}>
        <Plus size={14} />
      </button>
    </div>
  );
}
