import { useEffect, useRef, useState } from 'react';
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates,
  verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GripVertical } from 'lucide-react';
import type { Artikel } from '../api/types';
import { Card, Badge } from './ui';
import { ConsumerDots } from './ConsumerChips';
import { CanonicalIcon } from './IconPicker';
import { toast } from './Toast';
import { api } from '../api/client';
import { eur } from '../lib/utils';

export function SortableArticleList({ receiptId, artikel, onEdit, highlightIds, scrollToId }: {
  receiptId: number;
  artikel: Artikel[];
  onEdit: (a: Artikel) => void;
  highlightIds?: Set<number>;
  scrollToId?: number | null;
}) {
  const qc = useQueryClient();
  const [items, setItems] = useState(artikel);

  // Sync from the server while preserving our optimistic order:
  //  - id set changed (add/remove/re-OCR) → take the server's list as-is
  //  - same set → keep local ORDER but refresh each item's DATA (so an edit
  //    like a new price shows up without a hard refresh)
  useEffect(() => {
    setItems(prev => {
      const serverSet = artikel.map(x => x.id).sort((a, b) => a - b).join(',');
      const localSet = prev.map(x => x.id).sort((a, b) => a - b).join(',');
      if (serverSet !== localSet) return artikel;
      const byId = new Map(artikel.map(a => [a.id, a]));
      return prev.map(p => byId.get(p.id) ?? p);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artikel]);

  const persist = useMutation({
    mutationFn: (order: number[]) =>
      api(`/api/receipts/${receiptId}/artikel-order`, { method: 'PUT', body: { order } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['receipt', String(receiptId)] }),
    onError: (err: Error) => toast(err.message, 'error'),
  });

  const sensors = useSensors(
    // small distance so a tap/click still opens the editor; only a real drag moves
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setItems(prev => {
      const oldIdx = prev.findIndex(x => x.id === active.id);
      const newIdx = prev.findIndex(x => x.id === over.id);
      const next = arrayMove(prev, oldIdx, newIdx);
      persist.mutate(next.map(x => x.id));
      return next;
    });
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map(a => a.id)} strategy={verticalListSortingStrategy}>
        <div className="flex min-w-0 flex-col gap-1.5">
          {items.map(a => (
            <SortableRow
              key={a.id}
              a={a}
              onEdit={() => onEdit(a)}
              highlighted={highlightIds?.has(a.id) ?? false}
              scrollHere={scrollToId === a.id}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ a, onEdit, highlighted, scrollHere }: { a: Artikel; onEdit: () => void; highlighted: boolean; scrollHere: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: a.id });
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollHere) rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [scrollHere]);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={el => { setNodeRef(el); rowRef.current = el; }} style={style} className="scroll-mt-20">
      <Card
        className={`flex min-w-0 items-center gap-1.5 px-1.5 py-2.5 sm:gap-2 sm:px-2 ${
          isDragging ? 'opacity-80 shadow-lg ring-2 ring-emerald-400'
            : highlighted ? 'bg-amber-50 ring-2 ring-amber-400 dark:bg-amber-950/30' : ''
        }`}
      >
        {/* drag handle */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Verschieben"
          className="shrink-0 cursor-grab touch-none rounded-md p-1 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:bg-zinc-800"
        >
          <GripVertical size={16} />
        </button>
        {/* body — tap to edit */}
        <button type="button" onClick={onEdit} className="flex min-w-0 flex-1 items-center gap-2 text-left sm:gap-3">
          {a.canonical_name && <CanonicalIcon name={a.canonical_name} size={32} />}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium">{a.canonical_name ?? a.ai_guess ?? a.name}</span>
              <ConsumerDots ids={a.consumers} />
            </div>
            {a.original_text && (
              <div className="truncate font-mono text-[11px] text-zinc-400">{a.original_text}</div>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-1">
              {a.category_path && <Badge>{a.category_path.split('/').pop()}</Badge>}
              {a.menge && <span className="text-xs text-zinc-400">{a.menge} {a.einheit ?? ''}</span>}
            </div>
          </div>
          <div className="tabular shrink-0 font-semibold">{eur(a.preis)}</div>
        </button>
      </Card>
    </div>
  );
}
