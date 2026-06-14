import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { TriangleAlert, Pencil, RotateCcw, Check, X, ChevronDown, Shield, Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { PantryItem } from '../api/types';
import { Card, Spinner, EmptyState, Badge, Input, Button } from '../components/ui';
import { CanonicalIcon } from '../components/IconPicker';
import { toast } from '../components/Toast';
import { cn, fmtDate } from '../lib/utils';

interface ReserveCharge { id: number; gekauft_am: string | null; ablauf_am: string | null; menge: number | null; einheit: string | null; notiz: string | null }

const num = (s: string): number | null => { const n = parseFloat(s.replace(',', '.')); return Number.isFinite(n) ? n : null; };
const fmtQty = (n: number | null): string => n == null ? '–' : (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

export function Pantry() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['pantry'], queryFn: () => api<PantryItem[]>('/api/pantry') });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
  const toggleExpand = (name: string) => setExpanded(prev => { const n = new Set(prev); n.has(name) ? n.delete(name) : n.add(name); return n; });

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
          const hasReserve = p.reserve_charges > 0 || p.reserve_min != null;
          const isEditing = editing === p.canonical_name;
          const isExp = expanded.has(p.canonical_name);
          return (
            <Card key={p.canonical_name} className="flex flex-col p-3">
              <div className="flex items-center gap-3">
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
                    {hasReserve && !isExp && (
                      <span className="inline-flex items-center gap-0.5 text-violet-500"><Shield size={11} /> {fmtQty(p.reserve_total)}{p.reserve_min != null && ` / ${fmtQty(p.reserve_min)}`}</span>
                    )}
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
                      <button type="button" onClick={() => clearOverride.mutate(p.canonical_name)} title={t('pantry.resetOverride')} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
                        <RotateCcw size={15} />
                      </button>
                    )}
                    <button type="button" onClick={() => toggleExpand(p.canonical_name)} title={t('pantry.reserve')} className={cn('rounded-lg p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800', hasReserve ? 'text-violet-500' : 'text-zinc-400')}>
                      <ChevronDown className={cn('h-4 w-4 transition-transform', isExp && 'rotate-180')} />
                    </button>
                  </div>
                )}
              </div>
              {isExp && (
                <ReservePanel
                  canonical={p.canonical_name} baseUnit={p.base_unit} reserveMin={p.reserve_min}
                  t={t} lang={i18n.language} onChanged={() => void qc.invalidateQueries({ queryKey: ['pantry'] })}
                />
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/** Iron-reserve sub-panel: a minimum-stock level + dated batches (expiry). */
function ReservePanel({ canonical, baseUnit, reserveMin, t, lang, onChanged }: {
  canonical: string; baseUnit: string | null; reserveMin: number | null; t: TFunction; lang: string; onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { data: charges } = useQuery({
    queryKey: ['reserve', canonical],
    queryFn: () => api<ReserveCharge[]>(`/api/reserve/${encodeURIComponent(canonical)}`),
  });
  const [bought, setBought] = useState('');
  const [expires, setExpires] = useState('');
  const [menge, setMenge] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['reserve', canonical] }); onChanged(); };

  const setMin = useMutation({
    mutationFn: (v: number | null) => api(`/api/names/${encodeURIComponent(canonical)}/meta`, { method: 'PATCH', body: { reserve_min: v } }),
    onSuccess: onChanged,
  });
  const addCharge = useMutation({
    mutationFn: () => api('/api/reserve', { method: 'POST', body: { canonical_name: canonical, gekauft_am: bought || null, ablauf_am: expires || null, menge: menge.trim() ? num(menge) : null, einheit: baseUnit } }),
    onSuccess: () => { setBought(''); setExpires(''); setMenge(''); refresh(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const delCharge = useMutation({ mutationFn: (id: number) => api(`/api/reserve/${id}`, { method: 'DELETE' }), onSuccess: refresh });

  const today = new Date().toISOString().slice(0, 10);
  const soonCut = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-xl border border-violet-200 bg-violet-50/50 p-2.5 dark:border-violet-900/50 dark:bg-violet-950/20">
      <div className="flex items-center gap-1.5 text-sm font-semibold"><Shield size={14} className="text-violet-500" /> {t('pantry.reserve')}</div>

      <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span>{t('pantry.reserveMin')}</span>
        <div className="w-20">
          <Input
            key={`min${canonical}`} inputMode="decimal" defaultValue={reserveMin ?? ''} placeholder="–"
            onBlur={e => { const v = e.target.value.trim(); const nv = v ? num(v) : null; if (nv !== reserveMin) setMin.mutate(nv); }}
          />
        </div>
        <span className="text-zinc-400">{baseUnit}</span>
      </div>

      <div className="flex flex-col divide-y divide-violet-100 dark:divide-violet-900/40">
        {(charges ?? []).map(c => {
          const expired = c.ablauf_am != null && c.ablauf_am < today;
          const soon = c.ablauf_am != null && !expired && c.ablauf_am <= soonCut;
          return (
            <div key={c.id} className="flex items-center gap-2 py-1.5 text-xs">
              <span className="tabular font-medium">{fmtQty(c.menge)} {c.einheit ?? baseUnit}</span>
              {c.ablauf_am && (
                <span className={cn('tabular', expired ? 'font-semibold text-red-500' : soon ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400')}>
                  {t('pantry.expiresOn')} {fmtDate(c.ablauf_am, lang)}
                </span>
              )}
              {c.gekauft_am && <span className="text-zinc-400">· {fmtDate(c.gekauft_am, lang)}</span>}
              <button type="button" onClick={() => delCharge.mutate(c.id)} className="ml-auto rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Trash2 size={13} /></button>
            </div>
          );
        })}
        {!(charges ?? []).length && <div className="py-1 text-xs text-zinc-400">{t('pantry.noCharges')}</div>}
      </div>

      <form onSubmit={e => { e.preventDefault(); addCharge.mutate(); }} className="flex flex-wrap items-center gap-1.5">
        <div className="w-16"><Input inputMode="decimal" value={menge} onChange={e => setMenge(e.target.value)} placeholder={t('pantry.qty')} /></div>
        <div className="w-36"><Input type="date" value={bought} onChange={e => setBought(e.target.value)} title={t('pantry.boughtOn')} /></div>
        <div className="w-36"><Input type="date" value={expires} onChange={e => setExpires(e.target.value)} title={t('pantry.expiresOn')} /></div>
        <Button type="submit" className="px-2.5" disabled={addCharge.isPending}><Plus size={15} /></Button>
      </form>
    </div>
  );
}
