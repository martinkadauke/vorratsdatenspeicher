import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Search, ArrowRightLeft, ChevronRight, ChevronDown, Store as StoreIco, SlidersHorizontal, MapPin, Plus } from 'lucide-react';
import { api } from '../api/client';
import { Card, Input, Button, Label, Modal, Spinner, EmptyState, Select } from '../components/ui';
import { StoreIcon } from '../components/IconPicker';
import { eur } from '../lib/utils';
import { searchMatch } from '../lib/search';
import { useUrlState } from '../hooks/useUrlState';
import { useAuth } from '../context/auth';
import { toast } from '../components/Toast';

interface Filiale { name: string; receipts: number; total: number; branch_id: number | null }
interface StoreRow {
  key: string;
  display: string;
  store_type: string | null;
  receipts: number;
  total: number;
  raw: string[];
  filialen?: Filiale[];
}

// Store-type vocabulary shared with the shopping-list scoping (Supermarkt/Drogerie/…).
const STORE_TYPES = ['Supermarkt', 'Drogerie', 'Baumarkt', 'Tierbedarf', 'Apotheke', 'Bäckerei', 'Online', 'Sonstiges'];

export function Stores() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canWrite = user?.can_write !== false;
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [search, setSearch] = useUrlState('q', '');
  const [view, setView] = useUrlState<'filialen' | 'shops'>('view', 'filialen');
  const [editing, setEditing] = useState<StoreRow | null>(null);
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

  // Offers for the user's subscribed products, grouped by retailer chain — used to
  // turn each store image into a prospectus link with an offer-count badge.
  const { data: offerChains } = useQuery({
    queryKey: ['offers-by-chain'],
    queryFn: () => api<{ chain_slug: string; store: string; count: number; prospekt_url: string }[]>('/api/offers/by-chain'),
    staleTime: 60_000,
  });
  const chainFor = (key: string) => (offerChains ?? []).find(c =>
    c.chain_slug === key || c.chain_slug.startsWith(key) || key.startsWith(c.chain_slug));

  const qc = useQueryClient();
  const setType = useMutation({
    mutationFn: ({ key, store_type }: { key: string; store_type: string | null }) =>
      api(`/api/stores/${encodeURIComponent(key)}/type`, { method: 'PUT', body: { store_type } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stores'] }),
  });

  // Discover nearby stores (OSM) / add one by name — so a fresh household has stores for the
  // Läden list + offers-by-store, without waiting for the first receipt.
  const discover = useMutation({
    mutationFn: () => api<{ added: number; found: number; reason: string }>('/api/stores/discover', { method: 'POST' }),
    onSuccess: (r) => {
      if (r.reason === 'no_address') toast(t('stores.needAddress'), 'info');
      else if (r.reason === 'geocode_failed') toast(t('stores.geocodeFailed'), 'error');
      else toast(r.added > 0 ? t('stores.discovered', { count: r.added }) : t('stores.discoveredNone'), r.added > 0 ? 'success' : 'info');
      void qc.invalidateQueries({ queryKey: ['stores'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const addStore = useMutation({
    mutationFn: (name: string) => api<{ added: boolean; name?: string; reason: string }>('/api/stores/add', { method: 'POST', body: { name } }),
    onSuccess: (r) => {
      if (r.reason === 'no_address') toast(t('stores.needAddress'), 'info');
      else if (r.reason === 'not_found') toast(t('stores.addNotFound'), 'info');
      else if (r.reason === 'exists') toast(t('stores.addExists', { name: r.name ?? addName }), 'info');
      else if (r.reason === 'geocode_failed') toast(t('stores.geocodeFailed'), 'error');
      else { toast(t('stores.added', { name: r.name }), 'success'); setAddOpen(false); setAddName(''); }
      void qc.invalidateQueries({ queryKey: ['stores'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data;
    return data.filter(s => searchMatch(search, [s.display, ...s.raw]));
  }, [data, search]);

  return (
    <div className="flex flex-col gap-3">
      {/* Filialen (physical, from Kassenbon) vs Shops (online, from Email) */}
      <div className="flex gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/60">
        {(['filialen', 'shops'] as const).map(v => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              view === v ? 'bg-white text-emerald-600 shadow-sm dark:bg-zinc-900' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}
          >
            {t(`stores.tab_${v}`)}
          </button>
        ))}
      </div>

      {view === 'shops' ? <ShopsView search={search} setSearch={setSearch} /> : (
      <>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input
          className="pl-9"
          placeholder={t('stores.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" className="flex-1 justify-center" disabled={discover.isPending} onClick={() => discover.mutate()}>
            <MapPin size={15} /> {discover.isPending ? t('stores.discovering') : t('stores.discoverNearby')}
          </Button>
          <Button variant="secondary" className="flex-1 justify-center" onClick={() => setAddOpen(true)}>
            <Plus size={15} /> {t('stores.addStore')}
          </Button>
        </div>
      )}

      {isLoading && <Spinner />}
      {!isLoading && !filtered.length && <EmptyState>{t('stores.empty')}</EmptyState>}

      <div className="flex flex-col gap-2">
        {filtered.map(s => {
          const multi = (s.filialen?.length ?? s.raw.length) > 1;
          const isOpen = expanded.has(s.key);
          const ch = chainFor(s.key);
          return (
            <Card key={s.key} className="flex min-w-0 flex-col px-3 py-2.5">
              <div className="flex min-w-0 items-stretch gap-3">
                {/* Store image links straight to the chain's prospectus (offer flyer);
                    a corner badge hints how many subscribed items are on offer. */}
                {ch ? (
                  <a
                    href={ch.prospekt_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    title={t('stores.prospektTitle', { count: ch.count })}
                    className="group relative shrink-0 self-center"
                  >
                    <StoreIcon storeKey={s.key} size={36} fallback={s.display[0]?.toUpperCase()} />
                    {ch.count > 0 && (
                      <span className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-emerald-600 px-0.5 text-[9px] font-bold text-white ring-2 ring-white dark:ring-zinc-900">
                        {ch.count}
                      </span>
                    )}
                  </a>
                ) : (
                  <span className="shrink-0 self-center">
                    <StoreIcon storeKey={s.key} size={36} fallback={s.display[0]?.toUpperCase()} />
                  </span>
                )}
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
                {/* single-branch chains: direct profile link (multi-branch get per-branch links in the expanded list) */}
                {!multi && s.filialen?.[0]?.branch_id != null && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); navigate(`/filialen/${s.filialen![0].branch_id}`); }}
                    title={t('stores.openProfile')}
                    className="shrink-0 self-center rounded-lg p-2 text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30"
                  >
                    <SlidersHorizontal size={16} />
                  </button>
                )}
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

              {/* Ladentyp — scopes shopping-list suggestions (only products bought at a
                  store of this type surface on a list of that type). */}
              <div className="mt-1.5 flex items-center gap-2" onClick={e => e.stopPropagation()}>
                <span className="shrink-0 text-xs text-zinc-400">{t('stores.typeLabel')}</span>
                <select
                  value={s.store_type ?? ''}
                  onChange={e => setType.mutate({ key: s.key, store_type: e.target.value || null })}
                  className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                >
                  <option value="">{t('stores.typeNone')}</option>
                  {STORE_TYPES.map(ty => <option key={ty} value={ty}>{ty}</option>)}
                </select>
              </div>

              {isOpen && s.filialen && (
                <div className="mt-2 flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                  {s.filialen.map(f => (
                    <div key={f.name} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => navigate(`/receipts?store=${encodeURIComponent(f.name)}`)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                      >
                        <StoreIco size={13} className="shrink-0 text-zinc-400" />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <span className="tabular shrink-0 text-xs text-zinc-400">{f.receipts} · {eur(f.total)}</span>
                      </button>
                      {f.branch_id != null && (
                        <button
                          type="button"
                          onClick={() => navigate(`/filialen/${f.branch_id}`)}
                          title={t('stores.openProfile')}
                          className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30"
                        >
                          <SlidersHorizontal size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <StoreEditModal store={editing} allStores={data ?? []} onClose={() => setEditing(null)} />

      {addOpen && (
        <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t('stores.addStore')}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-zinc-500">{t('stores.addHint')}</p>
            <Input autoFocus placeholder={t('stores.addPlaceholder')} value={addName}
              onChange={e => setAddName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && addName.trim()) addStore.mutate(addName.trim()); }} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAddOpen(false)}>{t('common.cancel')}</Button>
              <Button disabled={!addName.trim() || addStore.isPending} onClick={() => addStore.mutate(addName.trim())}>
                <Search size={15} /> {addStore.isPending ? t('stores.searching') : t('stores.addSearch')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      </>
      )}
    </div>
  );
}

interface Shop { id: number; name: string; chain_key: string; receipts: number; total: string | number; last_visit: string | null }

/** Online shops (Amazon, eBay …) — store_branch rows created from email
 *  receipts (quelle='email'). Empty until email ingestion exists. */
function ShopsView({ search, setSearch }: { search: string; setSearch: (v: string) => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['shops'],
    queryFn: () => api<Shop[]>('/api/filialen?kind=shop'),
  });
  const filtered = useMemo(
    () => (data ?? []).filter(s => !search.trim() || searchMatch(search, [s.name, s.chain_key])),
    [data, search],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input className="pl-9" placeholder={t('stores.searchShops')} value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      {isLoading && <Spinner />}
      {!isLoading && !filtered.length && <EmptyState>{t('stores.shopsEmpty')}</EmptyState>}
      <div className="flex flex-col gap-2">
        {filtered.map(s => (
          <Card key={s.id} className="flex items-center gap-3 px-3 py-2.5">
            <StoreIcon storeKey={s.chain_key} size={36} fallback={s.name[0]?.toUpperCase()} />
            <button type="button" onClick={() => navigate(`/filialen/${s.id}`)} className="min-w-0 flex-1 text-left">
              <div className="truncate font-medium">{s.name}</div>
              <div className="text-xs text-zinc-400">
                {s.receipts} {t('stores.receipts')}{s.last_visit ? ` · ${new Date(s.last_visit).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'de-DE')}` : ''}
              </div>
            </button>
            <span className="tabular shrink-0 text-sm font-semibold text-emerald-600 dark:text-emerald-500">{eur(s.total)}</span>
            <ChevronRight size={16} className="shrink-0 text-zinc-300" />
          </Card>
        ))}
      </div>
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
