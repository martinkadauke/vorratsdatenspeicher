import { useMemo, useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, MapPin, Clock, FileText } from 'lucide-react';
import { api } from '../api/client';
import { Card, Button, Input, Label, Select, Spinner, Badge } from '../components/ui';
import { eur, fmtDate } from '../lib/utils';
import { toast } from '../components/Toast';

interface Branch {
  id: number; chain_key: string; name: string; kind: string;
  address: string | null;
  opening_hours: unknown | null;
  prospectus_url: string | null;
  warengruppen: string[][] | null;
  subscribed: boolean;
  receipts: number; total: string | number; last_visit: string | null;
}
interface Category { path: string; label: string; level: number; emoji: string | null; is_meta: boolean }

export function FilialProfil() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const qc = useQueryClient();

  const { data: branch, isLoading } = useQuery({
    queryKey: ['filiale', id],
    queryFn: () => api<Branch>(`/api/filialen/${id}`),
    enabled: !!id,
  });
  const { data: categories } = useQuery({
    queryKey: ['categories', i18n.language],
    queryFn: () => api<Category[]>(`/api/categories?lang=${i18n.language}`),
  });

  const [address, setAddress] = useState('');
  const [tiers, setTiers] = useState<string[][]>([]);
  const [dirty, setDirty] = useState(false);

  // seed local state once the branch loads
  useEffect(() => {
    if (branch) {
      setAddress(branch.address ?? '');
      setTiers(Array.isArray(branch.warengruppen) ? branch.warengruppen.map(t2 => [...t2]) : []);
      setDirty(false);
    }
  }, [branch]);

  const save = useMutation({
    mutationFn: () => api(`/api/filialen/${id}`, { method: 'PATCH', body: { address, warengruppen: tiers } }),
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
        <TierEditor
          tiers={tiers}
          categories={categories ?? []}
          onChange={mark(setTiers)}
        />
      </Card>

      {/* WIP profile features */}
      <Card className="flex flex-col gap-2 p-4 opacity-70">
        <h2 className="text-sm font-semibold text-zinc-500">{t('filiale.comingSoon')}</h2>
        <div className="flex flex-wrap gap-2">
          <WipChip icon={<Clock size={13} />} label={t('filiale.openingHours')} />
          <WipChip icon={<FileText size={13} />} label={t('filiale.prospectus')} />
          <WipChip icon={<span className="text-[13px] leading-none">🔔</span>} label={t('filiale.subscribe')} />
        </div>
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

function WipChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  const { t } = useTranslation();
  return (
    <span
      title={t('filiale.wipHint')}
      className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-2 py-1 text-xs text-zinc-400 dark:border-zinc-700"
    >
      {icon} {label} <span className="rounded bg-zinc-200 px-1 text-[10px] dark:bg-zinc-700">WIP</span>
    </span>
  );
}

/** Ordered tiers; each tier holds 1+ categories treated as parallel/equal.
 *  Reorder tiers with the arrows, add/remove categories via the dropdown/chips. */
function TierEditor({ tiers, categories, onChange }: {
  tiers: string[][];
  categories: Category[];
  onChange: (next: string[][]) => void;
}) {
  const { t } = useTranslation();
  const byPath = useMemo(() => new Map(categories.map(c => [c.path, c])), [categories]);
  const placed = useMemo(() => new Set(tiers.flat()), [tiers]);
  const unplaced = useMemo(
    () => categories.filter(c => !placed.has(c.path)).sort((a, b) => a.level - b.level || a.label.localeCompare(b.label)),
    [categories, placed],
  );

  const label = (path: string) => {
    const c = byPath.get(path);
    if (!c) return path.split('/').pop() ?? path; // category may have been deleted
    return `${c.emoji ? c.emoji + ' ' : ''}${c.label}`;
  };

  const moveTier = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= tiers.length) return;
    const next = tiers.map(t2 => [...t2]);
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const removeFromTier = (i: number, path: string) =>
    onChange(tiers.map((tier, k) => (k === i ? tier.filter(p => p !== path) : tier)).filter(tier => tier.length));
  const addToTier = (i: number, path: string) => {
    if (!path) return;
    onChange(tiers.map((tier, k) => (k === i ? [...tier, path] : tier)));
  };
  const addTier = (path: string) => { if (path) onChange([...tiers, [path]]); };

  return (
    <div className="flex flex-col gap-2">
      {tiers.map((tier, i) => (
        <div key={i} className="flex items-start gap-2 rounded-xl border border-zinc-200 p-2 dark:border-zinc-800">
          <div className="flex shrink-0 flex-col items-center gap-0.5 pt-0.5">
            <span className="text-xs font-semibold text-zinc-400">{i + 1}</span>
            <button type="button" onClick={() => moveTier(i, -1)} disabled={i === 0}
              className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">▲</button>
            <button type="button" onClick={() => moveTier(i, 1)} disabled={i === tiers.length - 1}
              className="rounded p-0.5 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800">▼</button>
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {tier.map(path => (
              <span key={path} className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                {label(path)}
                <button type="button" onClick={() => removeFromTier(i, path)} className="text-emerald-400 hover:text-red-500">✕</button>
              </span>
            ))}
            {tier.length > 1 && <span className="text-[10px] uppercase tracking-wide text-zinc-400">{t('filiale.parallel')}</span>}
            <AddCategory unplaced={unplaced} onPick={p => addToTier(i, p)} placeholder={t('filiale.addCategory')} />
          </div>
        </div>
      ))}

      {/* add a new tier */}
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-2 dark:border-zinc-700">
        <span className="shrink-0 text-xs font-medium text-zinc-400">{t('filiale.newTier')}</span>
        <AddCategory unplaced={unplaced} onPick={addTier} placeholder={t('filiale.addCategory')} />
      </div>

      {!tiers.length && <p className="text-xs text-zinc-400">{t('filiale.warengruppenEmpty')}</p>}
      {unplaced.length > 0 && (
        <p className="text-[11px] text-zinc-400">{t('filiale.unplacedCount', { count: unplaced.length })}</p>
      )}
    </div>
  );
}

/** A reset-on-pick dropdown of the still-unplaced categories. */
function AddCategory({ unplaced, onPick, placeholder }: {
  unplaced: Category[]; onPick: (path: string) => void; placeholder: string;
}) {
  const [val, setVal] = useState('');
  if (!unplaced.length) return null;
  return (
    <Select
      className="h-7 w-auto min-w-[8rem] py-0 text-xs"
      value={val}
      onChange={e => { onPick(e.target.value); setVal(''); }}
    >
      <option value="">+ {placeholder}</option>
      {unplaced.map(c => (
        <option key={c.path} value={c.path}>
          {' '.repeat((c.level - 1) * 2)}{c.emoji ? c.emoji + ' ' : ''}{c.label}
        </option>
      ))}
    </Select>
  );
}
