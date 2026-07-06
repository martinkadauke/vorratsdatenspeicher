import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wallet, Plus, Pencil, Trash2, Home, User as UserIcon, Info } from 'lucide-react';
import { api } from '../api/client';
import { Card, Spinner, Button, Input, Label, Select, Switch, Modal, EmptyState } from '../components/ui';
import { CategoryPicker } from '../components/CategoryPicker';
import { toast } from '../components/Toast';
import { eur, cn } from '../lib/utils';

interface FixedCost {
  id: number; label: string; category_path: string | null; monthly_eur: number;
  konto_id: number | null; start_date: string; end_date: string | null; active: boolean;
  konto_name: string | null; is_shared: boolean | null; konto_user_id: number | null; owner: string | null;
}
interface KontoLite { id: number; name: string; is_shared: boolean; is_cash: boolean; user_id: number | null; owner: string | null }

const today = () => new Date().toISOString().slice(0, 10);
type Draft = { id?: number; label: string; monthly_eur: string; konto_id: string; category_path: string | null; start_date: string; end_date: string; active: boolean };
const emptyDraft = (kontoId?: number): Draft => ({
  label: '', monthly_eur: '', konto_id: kontoId ? String(kontoId) : '', category_path: null,
  start_date: today(), end_date: '', active: true,
});

export function Finanzen() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [modal, setModal] = useState<Draft | null>(null);

  const { data: costs, isLoading } = useQuery({ queryKey: ['fixed-costs'], queryFn: () => api<FixedCost[]>('/api/fixed-costs') });
  const { data: konten } = useQuery({ queryKey: ['konten'], queryFn: () => api<KontoLite[]>('/api/konten') });

  // Scope options: every non-cash account. Shared = household (rent, loan…),
  // the rest = per person/account. Cash accounts don't carry standing costs.
  const scopeKonten = useMemo(() => (konten ?? []).filter(k => !k.is_cash), [konten]);
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['fixed-costs'] });

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = {
        label: d.label.trim(),
        monthly_eur: d.monthly_eur,
        konto_id: Number(d.konto_id),
        category_path: d.category_path,
        start_date: d.start_date,
        end_date: d.end_date || null,
        active: d.active,
      };
      return d.id
        ? api(`/api/fixed-costs/${d.id}`, { method: 'PATCH', body })
        : api('/api/fixed-costs', { method: 'POST', body });
    },
    onSuccess: () => { invalidate(); setModal(null); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const readd = useMutation({
    mutationFn: (c: FixedCost) => api('/api/fixed-costs', {
      method: 'POST',
      body: { label: c.label, monthly_eur: c.monthly_eur, konto_id: c.konto_id, category_path: c.category_path, start_date: c.start_date, end_date: c.end_date, active: c.active },
    }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (c: FixedCost) => api(`/api/fixed-costs/${c.id}`, { method: 'DELETE' }),
    onSuccess: (_r, c) => {
      invalidate();
      toast(t('finances.removedToast', { label: c.label }), 'info', 6000, { label: t('finances.undo'), onClick: () => readd.mutate(c) });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // Group by konto: household (shared) first, then each person.
  const groups = useMemo(() => {
    const byKonto = new Map<number, { konto: KontoLite | undefined; items: FixedCost[] }>();
    for (const k of scopeKonten) byKonto.set(k.id, { konto: k, items: [] });
    for (const c of costs ?? []) {
      if (c.konto_id == null) continue;
      if (!byKonto.has(c.konto_id)) byKonto.set(c.konto_id, { konto: konten?.find(k => k.id === c.konto_id), items: [] });
      byKonto.get(c.konto_id)!.items.push(c);
    }
    return [...byKonto.values()].sort((a, b) =>
      (b.konto?.is_shared ? 1 : 0) - (a.konto?.is_shared ? 1 : 0) ||
      (a.konto?.owner ?? '').localeCompare(b.konto?.owner ?? ''));
  }, [costs, konten, scopeKonten]);

  const monthlyTotal = (costs ?? []).filter(c => c.active).reduce((s, c) => s + c.monthly_eur, 0);
  // Shared "Haushaltskonto" → "Haushalt"; other shared accounts keep their name
  // (e.g. "Paypal"); personal accounts show the owner, else the account name.
  const scopeLabel = (k: KontoLite | undefined) =>
    !k ? '?' : k.is_shared ? (/haushalt/i.test(k.name) ? t('finances.household') : k.name) : (k.owner ?? k.name);

  if (isLoading || !konten) return <Spinner />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wallet size={20} className="text-emerald-500" />
          <h1 className="text-lg font-bold">{t('finances.title')}</h1>
        </div>
        <Button onClick={() => setModal(emptyDraft(scopeKonten[0]?.id))}>
          <Plus size={16} /> {t('finances.add')}
        </Button>
      </div>

      <Card className="flex items-center justify-between p-4">
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{t('finances.monthlyTotal')}</span>
        <span className="text-lg font-bold text-emerald-600 dark:text-emerald-500">{eur(monthlyTotal)}<span className="text-sm font-normal text-zinc-400">{t('finances.perMonth')}</span></span>
      </Card>

      <Card className="flex items-start gap-3 p-3 text-xs text-zinc-500 dark:text-zinc-400">
        <Info size={16} className="mt-0.5 shrink-0 text-sky-500" />
        <span>{t('finances.hint')}</span>
      </Card>

      {groups.filter(g => g.items.length > 0 || g.konto).map(g => {
        const sum = g.items.filter(c => c.active).reduce((s, c) => s + c.monthly_eur, 0);
        const isHome = !!g.konto?.is_shared;
        return (
          <div key={g.konto?.id ?? 'none'} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                {isHome ? <Home size={15} className="text-violet-500" /> : <UserIcon size={15} className="text-emerald-500" />}
                {scopeLabel(g.konto)}
                <span className="font-normal text-zinc-400">· {eur(sum)}{t('finances.perMonth')}</span>
              </div>
              <button
                onClick={() => setModal(emptyDraft(g.konto?.id))}
                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"
                title={t('finances.add')}
              >
                <Plus size={16} />
              </button>
            </div>
            {g.items.length === 0
              ? <Card className="p-3 text-xs text-zinc-400">{t('finances.emptyScope')}</Card>
              : g.items.map(c => (
                <Card key={c.id} className={cn('flex items-center gap-3 p-3', !c.active && 'opacity-50')}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{c.label}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                      {c.category_path && <span className="truncate">{c.category_path.split('/').pop()}</span>}
                      {!c.active && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t('finances.inactive')}</span>}
                      {c.end_date && <span>{t('finances.until')} {c.end_date}</span>}
                    </div>
                  </div>
                  <span className="shrink-0 text-sm font-semibold">{eur(c.monthly_eur)}<span className="text-xs font-normal text-zinc-400">{t('finances.perMonth')}</span></span>
                  <button onClick={() => setModal({ id: c.id, label: c.label, monthly_eur: String(c.monthly_eur).replace('.', ','), konto_id: String(c.konto_id ?? ''), category_path: c.category_path, start_date: c.start_date, end_date: c.end_date ?? '', active: c.active })}
                    className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" title={t('common.edit')}>
                    <Pencil size={15} />
                  </button>
                  <button onClick={() => remove.mutate(c)}
                    className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30" title={t('common.delete')}>
                    <Trash2 size={15} />
                  </button>
                </Card>
              ))}
          </div>
        );
      })}
      {!groups.some(g => g.items.length) && <EmptyState>{t('finances.empty')}</EmptyState>}

      {modal && (
        <Modal open onClose={() => setModal(null)} title={modal.id ? t('finances.editTitle') : t('finances.addTitle')}>
          <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (modal.label.trim() && modal.monthly_eur && modal.konto_id) save.mutate(modal); }}>
            <div>
              <Label>{t('finances.label')}</Label>
              <Input autoFocus value={modal.label} onChange={e => setModal({ ...modal, label: e.target.value })} placeholder={t('finances.labelPlaceholder')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('finances.monthly')}</Label>
                <Input inputMode="decimal" value={modal.monthly_eur} onChange={e => setModal({ ...modal, monthly_eur: e.target.value })} placeholder="0,00" />
              </div>
              <div>
                <Label>{t('finances.scope')}</Label>
                <Select value={modal.konto_id} onChange={e => setModal({ ...modal, konto_id: e.target.value })}>
                  <option value="" disabled>–</option>
                  {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabel(k)}</option>)}
                </Select>
              </div>
            </div>
            <div>
              <Label>{t('finances.category')} <span className="text-zinc-400">({t('common.optional')})</span></Label>
              <CategoryPicker value={modal.category_path} onChange={p => setModal({ ...modal, category_path: p })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('finances.startDate')}</Label>
                <Input type="date" value={modal.start_date} onChange={e => setModal({ ...modal, start_date: e.target.value })} />
              </div>
              <div>
                <Label>{t('finances.endDate')} <span className="text-zinc-400">({t('common.optional')})</span></Label>
                <Input type="date" value={modal.end_date} onChange={e => setModal({ ...modal, end_date: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Switch checked={modal.active} onChange={v => setModal({ ...modal, active: v })} /> {t('finances.activeLabel')}
            </label>
            <div className="mt-1 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setModal(null)}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={!modal.label.trim() || !modal.monthly_eur || !modal.konto_id || save.isPending}>{t('common.save')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
