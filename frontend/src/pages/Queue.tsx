import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ReceiptText, Search, X, CheckSquare, Square, Check, Ban, ArrowRight } from 'lucide-react';
import { api } from '../api/client';
import type { PruefenGroup, UnitPruefenRow, MixedUnitRow } from '../api/types';
import { Card, Spinner, EmptyState, Button, Input, Select } from '../components/ui';
import { CanonicalCombo } from '../components/CanonicalCombo';
import { UnitSelect } from '../components/UnitSelect';
import { CanonicalIcon } from '../components/IconPicker';
import { FirstVisitHint } from '../components/FirstVisitHint';
import { toast } from '../components/Toast';
import { cn } from '../lib/utils';
import { useUrlState } from '../hooks/useUrlState';

function confColor(c: string | null): string {
  const v = c ? parseFloat(c) : NaN;
  if (!Number.isFinite(v)) return 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  if (v >= 0.7) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
  if (v >= 0.5) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
  return 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400';
}

function TabBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        active ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300',
      )}
    >
      {label}
      {count > 0 && (
        <span className={cn('rounded-full px-1.5 py-0.5 text-[11px] font-semibold', active
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400'
          : 'bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-300')}>{count}</span>
      )}
    </button>
  );
}

export function Queue() {
  const { t } = useTranslation();
  const [tab, setTab] = useUrlState('tab', 'names');
  const { data: nameData } = useQuery({
    queryKey: ['pruefen'],
    queryFn: () => api<{ items: PruefenGroup[]; total: number }>('/api/pruefen'),
  });
  const { data: unitData } = useQuery({
    queryKey: ['pruefen-units'],
    queryFn: () => api<{ items: UnitPruefenRow[]; total: number }>('/api/pruefen-units'),
  });

  return (
    <div className="flex flex-col gap-3 pb-20">
      <FirstVisitHint id="queue1" titleKey="hint.queue.title" bodyKey="hint.queue.body" />

      <div className="flex gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800">
        <TabBtn active={tab === 'names'} onClick={() => setTab('names')} label={t('queue.tabNames')} count={nameData?.total ?? 0} />
        <TabBtn active={tab === 'units'} onClick={() => setTab('units')} label={t('queue.tabUnits')} count={unitData?.total ?? 0} />
      </div>

      {tab === 'units' ? <UnitReview /> : <NameReview />}
    </div>
  );
}

// ── Name review (canonical name confirmation) ───────────────────────────────
function NameReview() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [search, setSearch] = useUrlState('q', '');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ['pruefen'],
    queryFn: () => api<{ items: PruefenGroup[]; total: number }>('/api/pruefen'),
  });
  const all = data?.items ?? [];
  const total = data?.total ?? 0;

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(g =>
      (g.original_text ?? '').toLowerCase().includes(q) ||
      (g.suggestion ?? '').toLowerCase().includes(q) ||
      (g.ai_guess ?? '').toLowerCase().includes(q));
  }, [all, search]);

  const valueOf = (g: PruefenGroup) => edits[g.grp] ?? g.suggestion ?? g.ai_guess ?? '';

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['pruefen'] });
    void qc.invalidateQueries({ queryKey: ['pruefen-count'] });
    void qc.invalidateQueries({ queryKey: ['names'] });
    void qc.invalidateQueries({ queryKey: ['artikel-list'] });
  };

  const decide = useMutation({
    mutationFn: (b: { artikel_ids: number[]; canonical?: string; action: string }) =>
      api('/api/pruefen/decide', { method: 'POST', body: b }),
    onSuccess: () => { invalidate(); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const decideBulk = useMutation({
    mutationFn: (b: { action: string; items: { artikel_ids: number[]; canonical?: string }[] }) =>
      api<{ count: number }>('/api/pruefen/decide-bulk', { method: 'POST', body: b }),
    onSuccess: (r) => { invalidate(); setSelected(new Set()); toast(t('queue.bulkDone', { count: r.count }), 'success'); },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const allSelected = items.length > 0 && items.every(g => selected.has(g.grp));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map(g => g.grp)));
  const toggleOne = (grp: string) => setSelected(prev => {
    const n = new Set(prev); n.has(grp) ? n.delete(grp) : n.add(grp); return n;
  });

  const selectedGroups = items.filter(g => selected.has(g.grp));
  const bulkApprove = () => decideBulk.mutate({
    action: 'approve',
    items: selectedGroups.filter(g => valueOf(g).trim()).map(g => ({ artikel_ids: g.artikel_ids, canonical: valueOf(g).trim() })),
  });
  const bulkReject = () => decideBulk.mutate({
    action: 'reject', items: selectedGroups.map(g => ({ artikel_ids: g.artikel_ids })),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input className="pl-9 pr-9" placeholder={t('queue.search')} value={search} onChange={e => setSearch(e.target.value)} />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={15} />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <button onClick={toggleAll} className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {allSelected ? <CheckSquare size={15} className="text-emerald-500" /> : <Square size={15} />} {t('artikel.selectAll')}
        </button>
        <span>
          {t('queue.countOpen', { count: total })}
          {items.length < all.length ? ` · ${t('queue.showing', { n: items.length })}` : ''}
        </span>
      </div>

      {isLoading && <Spinner />}
      {!isLoading && !items.length && <EmptyState>{search ? '–' : t('queue.empty')}</EmptyState>}

      <div className="flex flex-col gap-2">
        {items.map(g => {
          const value = valueOf(g);
          const isSel = selected.has(g.grp);
          return (
            <Card key={g.grp} className={cn('flex flex-col gap-2 p-3', isSel && 'ring-2 ring-emerald-400')}>
              <div className="flex items-start gap-2">
                <button onClick={() => toggleOne(g.grp)} className="mt-0.5 shrink-0 text-zinc-400 hover:text-emerald-500" aria-label={t('artikel.select')}>
                  {isSel ? <CheckSquare size={18} className="text-emerald-500" /> : <Square size={18} />}
                </button>
                {value && <CanonicalIcon name={value} size={28} />}
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-zinc-400">{t('queue.ocr')}</div>
                  <div className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-300">{g.original_text ?? g.ai_guess ?? '–'}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {g.occurrences > 1 && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {t('queue.times', { count: g.occurrences })}
                    </span>
                  )}
                  {g.confidence && <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', confColor(g.confidence))}>{g.confidence}</span>}
                  {g.einkauf_id && (
                    <Link
                      to={`/receipts/${g.einkauf_id}${g.sample_artikel_id ? `?highlight=${g.sample_artikel_id}` : ''}`}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400"
                      title={t('queue.openReceipt')}
                    >
                      <ReceiptText size={13} /> #{g.einkauf_id}
                    </Link>
                  )}
                </div>
              </div>
              {(() => {
                // One-tap "teach" chips: the churner's proposal, the OCR product guess,
                // and the OCR's expanded name — deduped. Tapping one confirms it directly
                // (and learns the alias), so a wrong pre-fill like "Chili-Sauce" no longer
                // forces retyping when the faithful "Chili"/"Chili 50g" is right there.
                const cands = [g.suggestion, g.ai_guess, g.name]
                  .map(s => (s ?? '').trim())
                  .filter(Boolean)
                  .filter((s, i, arr) => arr.findIndex(x => x.toLowerCase() === s.toLowerCase()) === i);
                if (!cands.length) return null;
                return (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-zinc-400">{t('queue.adopt')}</span>
                    {cands.map(c => (
                      <button key={c} type="button" disabled={decide.isPending}
                        onClick={() => decide.mutate({ artikel_ids: g.artikel_ids, canonical: c, action: 'approve' })}
                        title={t('queue.adoptTitle', { name: c })}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                        <Check size={12} className="shrink-0" /> <span className="truncate">{c}</span>
                      </button>
                    ))}
                  </div>
                );
              })()}
              {/* Typeahead over the existing canonical names: a mangled OCR line
                  ("Grützen Johannes" for Griechischer Joghurt) is unfixable from
                  the chips alone — typing "Gri…" has to offer the name that's
                  already in the Warenstamm. Picking only FILLS the field; the
                  approve below stays the one place that merges + teaches the
                  alias. `inline` keeps Übernehmen/Verwerfen out from under the
                  list on a phone. */}
              <CanonicalCombo
                value={value}
                onChange={v => setEdits(prev => ({ ...prev, [g.grp]: v }))}
                placeholder={t('queue.proposed')}
                layout="inline"
              />
              <div className="flex flex-wrap gap-2">
                <Button className="min-w-[6rem] flex-1" disabled={!value.trim()} onClick={() => decide.mutate({ artikel_ids: g.artikel_ids, canonical: value.trim(), action: 'approve' })}>{t('queue.approve')}</Button>
              </div>
            </Card>
          );
        })}
      </div>

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 mx-auto flex max-w-2xl items-center gap-2 rounded-2xl border border-zinc-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 md:bottom-4">
          <span className="text-sm font-medium">{selected.size} {t('artikel.selected')}</span>
          <div className="ml-auto flex flex-wrap justify-end gap-1.5">
            <Button className="px-2.5" title={t('queue.approve')} aria-label={t('queue.approve')} onClick={bulkApprove} disabled={decideBulk.isPending}>
              <Check size={16} />
            </Button>
            <Button variant="secondary" className="px-2.5" title={t('queue.reject')} aria-label={t('queue.reject')} onClick={bulkReject} disabled={decideBulk.isPending}>
              <Ban size={16} />
            </Button>
            <Button variant="ghost" className="px-2.5" title={t('common.cancel')} aria-label={t('common.cancel')} onClick={() => setSelected(new Set())}>
              <X size={16} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Unit review (base_unit / Grundpreis-Einheit confirmation) ───────────────
function UnitReview() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [search, setSearch] = useUrlState('uq', '');
  const [unitEdits, setUnitEdits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ['pruefen-units'],
    queryFn: () => api<{ items: UnitPruefenRow[]; total: number; mixed?: MixedUnitRow[] }>('/api/pruefen-units'),
  });
  const all = data?.items ?? [];
  const total = data?.total ?? 0;
  const mixed = data?.mixed ?? [];

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(r =>
      r.canonical_name.toLowerCase().includes(q) || r.suggested_unit.toLowerCase().includes(q));
  }, [all, search]);

  const unitOf = (r: UnitPruefenRow) => unitEdits[r.canonical_name] ?? r.suggested_unit;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['pruefen-units'] });
    void qc.invalidateQueries({ queryKey: ['names'] });
    void qc.invalidateQueries({ queryKey: ['artikel-list'] });
    void qc.invalidateQueries({ queryKey: ['pantry'] });
    // base_unit + expected_price drive the shopping list (price/unit + store totals).
    void qc.invalidateQueries({ queryKey: ['shopping'] });
    void qc.invalidateQueries({ queryKey: ['shopping-list-mini'] });
    void qc.invalidateQueries({ queryKey: ['shopping-by-store'] });
  };

  const decide = useMutation({
    mutationFn: (b: { name: string; unit?: string; action: string }) =>
      api('/api/pruefen-units/decide', { method: 'POST', body: b }),
    onSuccess: invalidate,
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const decideBulk = useMutation({
    mutationFn: (b: { action: string; items: { name: string; unit?: string }[] }) =>
      api<{ count: number }>('/api/pruefen-units/decide-bulk', { method: 'POST', body: b }),
    onSuccess: (r, vars) => {
      invalidate();
      setSelected(new Set());
      toast(t(vars.action === 'apply' ? 'queue.bulkDone' : 'queue.units.bulkKept', { count: r.count }), 'success');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const allSelected = items.length > 0 && items.every(r => selected.has(r.canonical_name));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map(r => r.canonical_name)));
  const toggleOne = (name: string) => setSelected(prev => {
    const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n;
  });

  const selectedRows = items.filter(r => selected.has(r.canonical_name));
  const bulkApply = () => decideBulk.mutate({
    action: 'apply',
    items: selectedRows.filter(r => unitOf(r).trim()).map(r => ({ name: r.canonical_name, unit: unitOf(r).trim() })),
  });
  const bulkKeep = () => decideBulk.mutate({
    action: 'keep', items: selectedRows.map(r => ({ name: r.canonical_name })),
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('queue.units.intro')}</p>

      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input className="pl-9 pr-9" placeholder={t('queue.units.search')} value={search} onChange={e => setSearch(e.target.value)} />
        {search && (
          <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={15} />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <button onClick={toggleAll} className="flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {allSelected ? <CheckSquare size={15} className="text-emerald-500" /> : <Square size={15} />} {t('artikel.selectAll')}
        </button>
        <span>
          {t('queue.countOpen', { count: total })}
          {items.length < all.length ? ` · ${t('queue.showing', { n: items.length })}` : ''}
        </span>
      </div>

      {isLoading && <Spinner />}
      {!isLoading && !items.length && <EmptyState>{search ? '–' : t('queue.units.empty')}</EmptyState>}

      <div className="flex flex-col gap-2">
        {items.map(r => {
          const chosen = unitOf(r);
          const isSel = selected.has(r.canonical_name);
          return (
            <Card key={r.canonical_name} className={cn('flex flex-col gap-2 p-3', isSel && 'ring-2 ring-emerald-400')}>
              <div className="flex items-start gap-2">
                <button onClick={() => toggleOne(r.canonical_name)} className="mt-0.5 shrink-0 text-zinc-400 hover:text-emerald-500" aria-label={t('artikel.select')}>
                  {isSel ? <CheckSquare size={18} className="text-emerald-500" /> : <Square size={18} />}
                </button>
                <CanonicalIcon name={r.canonical_name} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{r.canonical_name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                    <span>{t('queue.units.current')}: <span className="font-medium text-zinc-600 dark:text-zinc-300">{r.current_unit ?? t('queue.units.noUnit')}</span></span>
                    <ArrowRight size={12} className="text-zinc-400" />
                    <span className="font-medium text-emerald-700 dark:text-emerald-400">{r.suggested_unit}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-400">{r.rationale}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {r.occurrences > 1 && (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      {t('queue.times', { count: r.occurrences })}
                    </span>
                  )}
                  <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', confColor(r.confidence))}>{r.confidence}</span>
                  {r.suggested_price != null && (
                    <span className="text-[11px] text-zinc-400">
                      {t('queue.units.priceHint', { price: r.suggested_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), unit: r.suggested_unit })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <UnitSelect className="min-w-[8rem] flex-1" value={chosen} allowEmpty={false} onChange={v => setUnitEdits(prev => ({ ...prev, [r.canonical_name]: v ?? '' }))} />
                <Button className="min-w-[6rem]" disabled={!chosen.trim()} onClick={() => decide.mutate({ name: r.canonical_name, unit: chosen.trim(), action: 'apply' })}>{t('queue.units.apply')}</Button>
                <Button variant="ghost" className="min-w-[5rem]" onClick={() => decide.mutate({ name: r.canonical_name, action: 'keep' })}>{t('queue.units.keep')}</Button>
              </div>
            </Card>
          );
        })}
      </div>

      <MixedUnits mixed={mixed} onDone={invalidate} />

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 mx-auto flex max-w-2xl items-center gap-2 rounded-2xl border border-zinc-200 bg-white/95 px-3 py-2 shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95 md:bottom-4">
          <span className="text-sm font-medium">{selected.size} {t('artikel.selected')}</span>
          <div className="ml-auto flex flex-wrap justify-end gap-1.5">
            <Button className="px-2.5" title={t('queue.units.apply')} aria-label={t('queue.units.apply')} onClick={bulkApply} disabled={decideBulk.isPending}>
              <Check size={16} />
            </Button>
            <Button variant="secondary" className="px-2.5" title={t('queue.units.keep')} aria-label={t('queue.units.keep')} onClick={bulkKeep} disabled={decideBulk.isPending}>
              <Ban size={16} />
            </Button>
            <Button variant="ghost" className="px-2.5" title={t('common.cancel')} aria-label={t('common.cancel')} onClick={() => setSelected(new Set())}>
              <X size={16} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Uneinheitliche Positionen": products whose receipt lines mix units (stk vs
 *  Packung vs blank). One click relabels the safely-relabelable lines (blank/
 *  unknown/count) to ONE count unit and sets the Grundpreis unit to match —
 *  mass/volume lines stay untouched. Rows vanish once the data is consistent. */
function MixedUnits({ mixed, onDone }: { mixed: MixedUnitRow[]; onDone: () => void }) {
  const { t } = useTranslation();
  const [unitEdits, setUnitEdits] = useState<Record<string, string>>({});
  const { data: units } = useQuery({
    queryKey: ['units'],
    queryFn: () => api<{ name: string; dimension: string }[]>('/api/units'),
  });
  const countUnits = (units ?? []).filter(u => u.dimension === 'count').map(u => u.name);
  const normalize = useMutation({
    mutationFn: (b: { name: string; unit: string }) =>
      api<{ updated: number }>('/api/pruefen-units/normalize', { method: 'POST', body: b }),
    onSuccess: (r) => { toast(t('queue.units.normalizeDone', { count: r.updated }), 'success'); onDone(); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  // Accept the discrepancy as-is (e.g. a kg product with a few blank lines):
  // hides the row for good, positions stay untouched.
  const accept = useMutation({
    mutationFn: (name: string) =>
      api('/api/pruefen-units/mixed-accept', { method: 'POST', body: { name } }),
    onSuccess: () => { toast(t('queue.units.mixedAccepted'), 'success'); onDone(); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  if (!mixed.length) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div>
        <h3 className="text-sm font-semibold">
          {t('queue.units.mixedTitle')} <span className="font-normal text-zinc-400">({mixed.length})</span>
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('queue.units.mixedIntro')}</p>
      </div>
      {mixed.map(r => {
        const chosen = unitEdits[r.canonical_name] ?? r.suggested_unit;
        return (
          <Card key={r.canonical_name} className="flex flex-col gap-2 p-3">
            <div className="flex items-start gap-2">
              <CanonicalIcon name={r.canonical_name} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.canonical_name}</div>
                <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {r.histogram.map(h => `${h.n}× ${h.label ?? t('queue.units.noUnit')}`).join(' · ')}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select className="min-w-[8rem] flex-1" value={chosen} onChange={e => setUnitEdits(prev => ({ ...prev, [r.canonical_name]: e.target.value }))}>
                {!countUnits.includes(chosen) && <option value={chosen}>{chosen}</option>}
                {countUnits.map(u => <option key={u} value={u}>{u}</option>)}
              </Select>
              <Button className="min-w-[8rem]" disabled={normalize.isPending} onClick={() => normalize.mutate({ name: r.canonical_name, unit: chosen })}>
                {t('queue.units.normalize')}
              </Button>
              <Button variant="ghost" className="min-w-[5rem]" disabled={accept.isPending} onClick={() => accept.mutate(r.canonical_name)}>
                {t('queue.units.mixedAccept')}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
