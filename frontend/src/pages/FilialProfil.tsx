import { useMemo, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, MapPin, Clock, FileText, Bell, BellRing, GripVertical, ExternalLink } from 'lucide-react';
import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { api } from '../api/client';
import { Card, Button, Input, Label, Spinner, Badge } from '../components/ui';
import { CategoryPicker, useCategories } from '../components/CategoryPicker';
import { eur, fmtDate } from '../lib/utils';
import { toast } from '../components/Toast';

interface Branch {
  id: number; chain_key: string; name: string; kind: string;
  address: string | null;
  opening_hours: { text?: string } | null;
  prospectus_url: string | null;
  warengruppen: string[][] | null;
  subscribed: boolean;
  receipts: number; total: string | number; last_visit: string | null;
}

// marktguru retailer slugs that differ from our normalized chain key.
const CHAIN_SLUG_ALIASES: Record<string, string> = { aldi: 'aldi-sued', netto: 'netto-marken-discount' };
/** Human-viewable regional prospectus for a chain key, e.g. lidl → /rp/lidl-prospekte. */
function marktguruProspektUrl(chainKey: string): string {
  const slug = CHAIN_SLUG_ALIASES[chainKey] ?? chainKey;
  return `https://www.marktguru.de/rp/${slug}-prospekte`;
}

export function FilialProfil() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const qc = useQueryClient();

  const { data: branch, isLoading } = useQuery({
    queryKey: ['filiale', id],
    queryFn: () => api<Branch>(`/api/filialen/${id}`),
    enabled: !!id,
  });
  const { data: subs } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => api<{ filiale: number[]; artikel: string[] }>('/api/subscriptions'),
  });
  const subscribed = !!subs?.filiale.includes(Number(id));
  const toggleSub = useMutation({
    mutationFn: () => api<{ subscribed: boolean }>('/api/subscriptions/toggle', { method: 'POST', body: { kind: 'filiale', ref: Number(id) } }),
    onSuccess: (r) => {
      toast(r.subscribed ? t('filiale.subscribed') : t('filiale.unsubscribed'), 'success');
      void qc.invalidateQueries({ queryKey: ['subscriptions'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const [address, setAddress] = useState('');
  const [hours, setHours] = useState('');
  const [tiers, setTiers] = useState<string[][]>([]);
  const [dirty, setDirty] = useState(false);

  // seed local state once the branch loads
  useEffect(() => {
    if (branch) {
      setAddress(branch.address ?? '');
      setHours(branch.opening_hours?.text ?? '');
      setTiers(Array.isArray(branch.warengruppen) ? branch.warengruppen.map(t2 => [...t2]) : []);
      setDirty(false);
    }
  }, [branch]);

  const save = useMutation({
    mutationFn: () => api(`/api/filialen/${id}`, { method: 'PATCH', body: { address, opening_hours: hours, warengruppen: tiers } }),
    onSuccess: () => {
      toast(t('common.saved'), 'success');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['filiale', id] });
      void qc.invalidateQueries({ queryKey: ['stores'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const mark = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setDirty(true); };

  if (isLoading || !branch) return <div className="py-10"><Spinner /></div>;

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {/* header */}
      <div className="flex items-center gap-2">
        <Link to="/stores" className="shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <ArrowLeft size={18} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold">{branch.name}</h1>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <Badge className="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">{branch.chain_key}</Badge>
            <span>{branch.kind === 'shop' ? t('filiale.kindShop') : t('filiale.kindFiliale')}</span>
          </div>
        </div>
      </div>

      {/* stats */}
      <Card className="grid grid-cols-3 gap-2 p-3 text-center">
        <div>
          <div className="text-base font-semibold tabular-nums">{branch.receipts}</div>
          <div className="text-xs text-zinc-400">{t('stores.receipts')}</div>
        </div>
        <div>
          <div className="text-base font-semibold tabular-nums text-emerald-600 dark:text-emerald-500">{eur(branch.total)}</div>
          <div className="text-xs text-zinc-400">{t('filiale.total')}</div>
        </div>
        <div>
          <div className="text-base font-semibold tabular-nums">{branch.last_visit ? fmtDate(branch.last_visit, i18n.language) : '–'}</div>
          <div className="text-xs text-zinc-400">{t('filiale.lastVisit')}</div>
        </div>
      </Card>

      {/* address */}
      <Card className="flex flex-col gap-2 p-4">
        <Label className="flex items-center gap-1.5"><MapPin size={14} /> {t('filiale.address')}</Label>
        <Input
          value={address}
          placeholder={t('filiale.addressPlaceholder')}
          onChange={e => mark(setAddress)(e.target.value)}
        />
      </Card>

      {/* warengruppen tier editor */}
      <Card className="flex flex-col gap-3 p-4">
        <div>
          <h2 className="text-base font-semibold">{t('filiale.warengruppen')}</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('filiale.warengruppenHint')}</p>
        </div>
        <TierEditor tiers={tiers} onChange={mark(setTiers)} />
      </Card>

      {/* offer subscription — active; the notification itself is still WIP */}
      <Card className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{t('filiale.subscribe')}</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('filiale.subscribeHint')}</p>
          </div>
          <Button
            variant={subscribed ? 'secondary' : 'primary'}
            onClick={() => toggleSub.mutate()}
            disabled={toggleSub.isPending}
            className="shrink-0"
          >
            {subscribed ? <BellRing size={15} /> : <Bell size={15} />}
            {subscribed ? t('filiale.subscribed') : t('filiale.subscribeAction')}
          </Button>
        </div>
      </Card>

      {/* opening hours — manual entry now; a weekly cron can auto-fill later */}
      <Card className="flex flex-col gap-2 p-4">
        <Label className="flex items-center gap-1.5"><Clock size={14} /> {t('filiale.openingHours')}</Label>
        <textarea
          value={hours}
          placeholder={t('filiale.openingHoursPlaceholder')}
          onChange={e => mark(setHours)(e.target.value)}
          rows={3}
          className="w-full rounded-xl border border-zinc-300 bg-transparent px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none dark:border-zinc-700"
        />
      </Card>

      {/* current prospectus — the regional marktguru flyer for this chain */}
      <Card className="flex items-center justify-between gap-2 p-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <FileText size={15} className="shrink-0 text-zinc-400" />
          <span className="truncate font-medium">{t('filiale.prospectus')}</span>
        </div>
        <a
          href={branch.prospectus_url || marktguruProspektUrl(branch.chain_key)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {t('filiale.viewProspekt')} <ExternalLink size={12} />
        </a>
      </Card>

      {/* sticky save */}
      <div className="sticky bottom-2 flex justify-end">
        <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          {save.isPending ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  );
}


/** Ordered tiers; each tier holds 1+ categories treated as parallel/equal.
 *  Reorder tiers with the arrows, add/remove categories via the dropdown/chips. */
function TierEditor({ tiers, onChange }: {
  tiers: string[][];
  onChange: (next: string[][]) => void;
}) {
  const { t } = useTranslation();
  // Single source of truth: the live category catalog (the same one the NL
  // category generator edits) — removed categories disappear here automatically.
  const { data: categories = [] } = useCategories();
  const byPath = useMemo(() => new Map(categories.map(c => [c.path, c])), [categories]);
  const placed = useMemo(() => new Set(tiers.flat()), [tiers]);

  // which tier we're adding to ('new' = a fresh tier) + the cascading pick
  const [target, setTarget] = useState<number | 'new' | null>(null);
  const [pickPath, setPickPath] = useState<string | null>(null);

  const label = (path: string) => {
    const c = byPath.get(path);
    if (!c) return path.split('/').pop() ?? path; // category may have been removed
    return `${c.emoji ? c.emoji + ' ' : ''}${c.label}`;
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    onChange(arrayMove(tiers, Number(active.id), Number(over.id)));
  };
  const removeFromTier = (i: number, path: string) =>
    onChange(tiers.map((tier, k) => (k === i ? tier.filter(p => p !== path) : tier)).filter(tier => tier.length));

  const startAdd = (tgt: number | 'new') => { setTarget(tgt); setPickPath(null); };
  const cancelAdd = () => { setTarget(null); setPickPath(null); };
  const confirmAdd = () => {
    const p = pickPath;
    if (!p || placed.has(p)) { cancelAdd(); return; } // ignore empty / duplicate
    if (target === 'new') onChange([...tiers, [p]]);
    else if (typeof target === 'number') onChange(tiers.map((tier, k) => (k === target ? [...tier, p] : tier)));
    cancelAdd();
  };

  return (
    <div className="flex flex-col gap-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={tiers.map((_, i) => i)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2">
            {tiers.map((tier, i) => (
              <SortableTier
                key={i}
                id={i}
                index={i}
                tier={tier}
                label={label}
                parallelLabel={t('filiale.parallel')}
                addLabel={t('filiale.addCategory')}
                onRemove={(p) => removeFromTier(i, p)}
                onAdd={() => startAdd(i)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* add a new tier */}
      <button
        type="button"
        onClick={() => startAdd('new')}
        className="self-start rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-500 hover:border-emerald-400 hover:text-emerald-600 dark:border-zinc-700"
      >
        + {t('filiale.newTier')}
      </button>

      {/* cascading 3-level picker, shown while adding */}
      {target !== null && (
        <div className="flex flex-col gap-2 rounded-xl border border-emerald-300 bg-emerald-50/40 p-3 dark:border-emerald-800/60 dark:bg-emerald-950/20">
          <div className="text-xs font-medium text-zinc-500">
            {target === 'new' ? t('filiale.addToNewTier') : t('filiale.addToTier', { n: target + 1 })}
          </div>
          <CategoryPicker value={pickPath} onChange={setPickPath} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={cancelAdd}>{t('common.cancel')}</Button>
            <Button onClick={confirmAdd} disabled={!pickPath || placed.has(pickPath)}>{t('common.add')}</Button>
          </div>
        </div>
      )}

      {!tiers.length && target === null && <p className="text-xs text-zinc-400">{t('filiale.warengruppenEmpty')}</p>}
    </div>
  );
}

/** One draggable tier row (drag the handle to reorder). */
function SortableTier({ id, index, tier, label, parallelLabel, addLabel, onRemove, onAdd }: {
  id: number; index: number; tier: string[];
  label: (p: string) => string; parallelLabel: string; addLabel: string;
  onRemove: (p: string) => void; onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  return (
    <div ref={setNodeRef} style={style}
      className="flex items-start gap-2 rounded-xl border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5">
        <span className="text-xs font-semibold text-zinc-400">{index + 1}</span>
        <button type="button" {...attributes} {...listeners}
          className="cursor-grab touch-none rounded p-0.5 text-zinc-400 hover:bg-zinc-100 active:cursor-grabbing dark:hover:bg-zinc-800">
          <GripVertical size={14} />
        </button>
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {tier.map(path => (
          <span key={path} className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            {label(path)}
            <button type="button" onClick={() => onRemove(path)} className="text-emerald-400 hover:text-red-500">&times;</button>
          </span>
        ))}
        {tier.length > 1 && <span className="text-[10px] uppercase tracking-wide text-zinc-400">{parallelLabel}</span>}
        <button type="button" onClick={onAdd}
          className="rounded-lg border border-dashed border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-500 hover:border-emerald-400 hover:text-emerald-600 dark:border-zinc-700">
          + {addLabel}
        </button>
      </div>
    </div>
  );
}
