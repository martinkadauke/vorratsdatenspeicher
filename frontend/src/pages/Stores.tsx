import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Search, ArrowRightLeft, Image as ImageIcon, ChevronRight, ChevronDown, Store as StoreIco } from 'lucide-react';
import { api } from '../api/client';
import { Card, Input, Button, Label, Modal, Spinner, EmptyState, Badge, Select } from '../components/ui';
import { IconPicker, StoreIcon } from '../components/IconPicker';
import { eur } from '../lib/utils';
import { searchMatch } from '../lib/search';

interface Filiale { name: string; receipts: number; total: number }
interface StoreRow {
  key: string;
  display: string;
  receipts: number;
  total: number;
  raw: string[];
  filialen?: Filiale[];
}

export function Stores() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<StoreRow | null>(null);
  const [iconPickerFor, setIconPickerFor] = useState<StoreRow | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (key: string) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const { data, isLoading } = useQuery({
    queryKey: ['stores'],
    queryFn: () => api<StoreRow[]>('/api/stores'),
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data;
    return data.filter(s => searchMatch(search, [s.display, ...s.raw]));
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
        {filtered.map(s => {
          const multi = (s.filialen?.length ?? s.raw.length) > 1;
          const isOpen = expanded.has(s.key);
          return (
            <Card key={s.key} className="flex min-w-0 flex-col px-3 py-2.5">
              <div className="flex min-w-0 items-stretch gap-3">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setIconPickerFor(s); }}
                  className="group shrink-0 self-center"
                  title={t('stores.changeIcon')}
                >
                  <StoreIcon storeKey={s.key} size={36} fallback={s.display[0]?.toUpperCase()} />
                </button>
                <div className="min-w-0 flex-1 cursor-pointer self-center" onClick={() => setEditing(s)}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-medium">{s.display}</span>
                    {multi && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); toggleExpand(s.key); }}
                        className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-400"
                        title={t('stores.showFilialen')}
                      >
                        {(s.filialen?.length ?? s.raw.length)} {t('stores.variants')}
                        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); navigate(`/receipts?store=${encodeURIComponent(s.key)}`); }}
                  className="group flex shrink-0 items-center gap-1 self-stretch rounded-lg px-2 text-right hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                  title={t('stores.viewReceipts')}
                >
                  <div className="flex flex-col items-end">
                    <span className="tabular text-sm font-semibold text-emerald-600 dark:text-emerald-500">{eur(s.total)}</span>
                    <span className="text-xs text-zinc-400">{s.receipts} {t('stores.receipts')}</span>
                  </div>
                  <ChevronRight size={14} className="text-zinc-300 group-hover:text-emerald-500" />
                </button>
              </div>

              {isOpen && s.filialen && (
                <div className="mt-2 flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                  {s.filialen.map(f => (
                    <button
                      key={f.name}
                      type="button"
                      onClick={() => navigate(`/receipts?store=${encodeURIComponent(f.name)}`)}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                    >
                      <StoreIco size={13} className="shrink-0 text-zinc-400" />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="tabular shrink-0 text-xs text-zinc-400">{f.receipts} · {eur(f.total)}</span>
                      <ChevronRight size={13} className="shrink-0 text-zinc-300" />
                    </button>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <StoreEditModal store={editing} allStores={data ?? []} onClose={() => setEditing(null)} />

      {iconPickerFor && (
        <IconPicker
          entity="store"
          canonicalName={iconPickerFor.key}
          searchSeed={`${iconPickerFor.display} logo`}
          open={!!iconPickerFor}
          onClose={() => setIconPickerFor(null)}
        />
      )}
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
