import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search, Store, ArrowRightLeft } from 'lucide-react';
import { api } from '../api/client';
import { Card, Input, Button, Label, Modal, Spinner, EmptyState, Badge, Select } from '../components/ui';
import { eur } from '../lib/utils';

interface StoreRow {
  key: string;
  display: string;
  receipts: number;
  total: number;
  raw: string[];
}

export function Stores() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<StoreRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<StoreRow[]>('/api/stores'),
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    return q ? data.filter(s => s.display.toLowerCase().includes(q) ||
                                s.raw.some(r => r.toLowerCase().includes(q))) : data;
  }, [data, search]);

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-bold">{t('stores.title')}</h1>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input
          className="pl-9"
          placeholder={t('stores.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {isLoading && <Spinner />}
      {!isLoading && !filtered.length && <EmptyState>{t('stores.empty')}</EmptyState>}

      <div className="flex flex-col gap-2">
        {filtered.map(s => (
          <Card key={s.key} onClick={() => setEditing(s)} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
            <Store size={18} className="shrink-0 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{s.display}</span>
                {s.raw.length > 1 && (
                  <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400">
                    {s.raw.length} {t('stores.variants')}
                  </Badge>
                )}
              </div>
              <div className="mt-0.5 truncate text-xs text-zinc-400">
                {s.receipts} {t('stores.receipts')} · {eur(s.total)}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <StoreEditModal store={editing} allStores={data ?? []} onClose={() => setEditing(null)} />
    </div>
  );
}

function StoreEditModal({ store, allStores, onClose }: {
  store: StoreRow | null;
  allStores: StoreRow[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'rename' | 'merge'>('rename');
  const [newName, setNewName] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [variantsToRename, setVariantsToRename] = useState<Set<string>>(new Set());

  // Reset when store changes
  if (store && variantsToRename.size === 0 && newName === '') {
    setNewName(store.display);
    setVariantsToRename(new Set(store.raw));
  }

  const onCloseReset = () => {
    setMode('rename');
    setNewName('');
    setMergeTarget('');
    setVariantsToRename(new Set());
    onClose();
  };

  const renameOne = useMutation({
    mutationFn: async () => {
      if (!store) return { updated: 0 };
      const tasks = [...variantsToRename].map(raw =>
        api<{ updated: number }>(`/api/stores/${encodeURIComponent(raw)}/rename`, {
          method: 'PUT',
          body: { new_name: newName },
        })
      );
      const results = await Promise.all(tasks);
      return { updated: results.reduce((s, r) => s + r.updated, 0) };
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['stores'] }); void qc.invalidateQueries({ queryKey: ['receipts'] }); onCloseReset(); },
  });

  const merge = useMutation({
    mutationFn: () => api<{ updated: number }>('/api/stores/merge', {
      method: 'POST',
      body: { from: store?.raw ?? [], to: mergeTarget },
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['stores'] }); void qc.invalidateQueries({ queryKey: ['receipts'] }); onCloseReset(); },
  });

  if (!store) return null;
  const otherStores = allStores.filter(s => s.key !== store.key);

  return (
    <Modal open={!!store} onClose={onCloseReset} title={store.display} wide>
      <div className="flex flex-col gap-4">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {store.receipts} {t('stores.receipts')} · {eur(store.total)}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode('rename')}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm ${mode === 'rename'
              ? 'border-emerald-500 bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'border-zinc-300 text-zinc-500 dark:border-zinc-700'}`}
          >
            {t('stores.modeRename')}
          </button>
          <button
            type="button"
            onClick={() => setMode('merge')}
            disabled={otherStores.length === 0}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm disabled:opacity-50 ${mode === 'merge'
              ? 'border-emerald-500 bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'border-zinc-300 text-zinc-500 dark:border-zinc-700'}`}
          >
            <ArrowRightLeft size={14} className="inline align-text-bottom" /> {t('stores.modeMerge')}
          </button>
        </div>

        {mode === 'rename' && (
          <>
            <div>
              <Label>{t('stores.newName')}</Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            {store.raw.length > 1 && (
              <div>
                <Label>{t('stores.applyToVariants')}</Label>
                <div className="flex flex-col gap-1.5">
                  {store.raw.map(raw => (
                    <label key={raw} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={variantsToRename.has(raw)}
                        onChange={e => {
                          const next = new Set(variantsToRename);
                          if (e.target.checked) next.add(raw); else next.delete(raw);
                          setVariantsToRename(next);
                        }}
                        className="h-4 w-4 accent-emerald-600"
                      />
                      <span className="truncate">{raw}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onCloseReset}>{t('common.cancel')}</Button>
              <Button
                onClick={() => renameOne.mutate()}
                disabled={!newName || variantsToRename.size === 0 || renameOne.isPending}
              >
                {t('common.save')}
              </Button>
            </div>
          </>
        )}

        {mode === 'merge' && (
          <>
            <p className="text-xs text-zinc-500">{t('stores.mergeHint')}</p>
            <div>
              <Label>{t('stores.mergeTarget')}</Label>
              <Select value={mergeTarget} onChange={e => setMergeTarget(e.target.value)}>
                <option value="">– {t('stores.pickTarget')} –</option>
                {otherStores.map(s => (
                  <option key={s.key} value={s.display}>{s.display} ({s.receipts})</option>
                ))}
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onCloseReset}>{t('common.cancel')}</Button>
              <Button
                variant="danger"
                onClick={() => merge.mutate()}
                disabled={!mergeTarget || merge.isPending}
              >
                {t('stores.merge')}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
