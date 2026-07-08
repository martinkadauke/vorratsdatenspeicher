import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wallet, Plus, Pencil, Trash2, Home, User as UserIcon, Info,
  ChevronLeft, ChevronRight, CheckCircle2, Circle, CircleDot, Search, X, Upload,
} from 'lucide-react';
import { api } from '../api/client';
import { Card, Spinner, Button, Input, Label, Select, Switch, Modal, EmptyState, Badge } from '../components/ui';
import { CategoryPicker } from '../components/CategoryPicker';
import { toast } from '../components/Toast';
import { eur, cn } from '../lib/utils';
import { useUrlState } from '../hooks/useUrlState';

// ── shared types ────────────────────────────────────────────────────────────

interface FixedCost {
  id: number; label: string; category_path: string | null; monthly_eur: number;
  konto_id: number | null; start_date: string; end_date: string | null; active: boolean;
  expect_receipt: boolean; match_merchant: string | null;
  konto_name: string | null; is_shared: boolean | null; konto_user_id: number | null; owner: string | null;
}
interface KontoLite { id: number; name: string; is_shared: boolean; is_cash: boolean; user_id: number | null; owner: string | null }

interface MonthFix {
  id: number; label: string; monthly_eur: number; expect_receipt: boolean; match_merchant: string | null;
  konto_id: number | null; konto_name: string | null; is_shared: boolean | null; owner: string | null;
  check: { status: 'confirmed' | 'skipped'; source: 'receipt' | 'bank' | 'none'; einkauf_id: number | null; bank_tx_id: number | null; amount: number | null; laden: string | null; datum: string | null } | null;
  suggestion: { source: 'receipt' | 'bank'; einkauf_id: number | null; bank_tx_id: number | null; laden: string | null; betrag: number; datum: string; amount_ok: boolean; merchant_ok: boolean } | null;
}
interface MonthBudget {
  id: number; label: string; monthly_target: number; konto_id: number | null;
  konto_name: string | null; is_shared: boolean | null; owner: string | null;
  categories: string[]; actual: number; forecast: number | null;
}
interface MonthData { month: string; fixed: MonthFix[]; budgets: MonthBudget[] }

const today = () => new Date().toISOString().slice(0, 10);
const curMonth = () => new Date().toISOString().slice(0, 7);
const shiftMonth = (m: string, d: number) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1 + d, 1)).toISOString().slice(0, 7);
};

function useKonten() {
  return useQuery({ queryKey: ['konten'], queryFn: () => api<KontoLite[]>('/api/konten') });
}
// Shared "Haushaltskonto" → "Haushalt"; other shared accounts keep their name;
// personal accounts show the owner, else the account name.
function scopeLabelOf(t: (k: string) => string, k: { is_shared?: boolean | null; name?: string | null; owner?: string | null; konto_name?: string | null } | undefined | null): string {
  if (!k) return '?';
  const name = (k as { name?: string | null }).name ?? (k as { konto_name?: string | null }).konto_name ?? '';
  if (k.is_shared) return /haushalt/i.test(name ?? '') ? t('finances.household') : (name ?? '?');
  return k.owner ?? name ?? '?';
}

// ── page shell: tabs ────────────────────────────────────────────────────────

export function Finanzen() {
  const { t } = useTranslation();
  const [tab, setTab] = useUrlState('tab', 'monat');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wallet size={20} className="text-emerald-500" />
          <h1 className="text-lg font-bold">{t('finances.title')}</h1>
        </div>
        <div className="flex rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800/60">
          {(['monat', 'verwaltung'] as const).map(tb => (
            <button key={tb} onClick={() => setTab(tb)}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                tab === tb ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')}
            >
              {t(tb === 'monat' ? 'finances.monthTab' : 'finances.manageTab')}
            </button>
          ))}
        </div>
      </div>
      {tab === 'verwaltung' ? <ManageTab /> : <MonthTab />}
    </div>
  );
}

// ── month view ──────────────────────────────────────────────────────────────

function MonthTab() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [month, setMonth] = useUrlState('m', curMonth());
  const [picker, setPicker] = useState<MonthFix | null>(null);
  const [budgetModal, setBudgetModal] = useState<Partial<MonthBudget> | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['fin-month', month],
    queryFn: () => api<MonthData>(`/api/finances/month?month=${month}`),
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['fin-month'] });

  const check = useMutation({
    mutationFn: (b: { fixed_cost_id: number; month: string; action: 'confirm' | 'skip' | 'clear'; einkauf_id?: number | null; bank_tx_id?: number | null }) =>
      api('/api/finances/check', { method: 'POST', body: b }),
    onSuccess: () => { invalidate(); setPicker(null); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(
    i18n.language === 'en' ? 'en-GB' : 'de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const fixed = data?.fixed ?? [];
  const budgets = data?.budgets ?? [];
  const fixTotal = fixed.reduce((s, f) => s + f.monthly_eur, 0);
  const isOk = (f: MonthFix) => !!f.check || f.expect_receipt === false;
  const okCount = fixed.filter(isOk).length;
  const varActual = budgets.reduce((s, b) => s + b.actual, 0);
  const varTarget = budgets.reduce((s, b) => s + b.monthly_target, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* month navigation */}
      <div className="flex items-center justify-center gap-3">
        <button onClick={() => setMonth(shiftMonth(month, -1))} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" aria-label="◄">
          <ChevronLeft size={18} />
        </button>
        <button onClick={() => setMonth(curMonth())} className="min-w-[10rem] text-center text-base font-semibold" title={t('finances.jumpToday')}>
          {monthLabel}
        </button>
        <button onClick={() => setMonth(shiftMonth(month, 1))} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" aria-label="►">
          <ChevronRight size={18} />
        </button>
      </div>

      {isLoading && <Spinner />}
      {data && (
        <>
          <Card className="grid grid-cols-2 gap-3 p-4">
            <div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('finances.fixTitle')}</div>
              <div className="text-lg font-bold">{eur(fixTotal)}</div>
              <div className={cn('text-xs', okCount === fixed.length && fixed.length > 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-amber-600 dark:text-amber-500')}>
                {t('finances.checkedOf', { done: okCount, total: fixed.length })}
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('finances.varTitle')}</div>
              <div className="text-lg font-bold">{eur(varActual)}</div>
              {varTarget > 0 && <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('finances.ofTarget', { target: eur(varTarget) })}</div>}
            </div>
          </Card>

          {/* fixed-cost checklist */}
          <div className="flex flex-col gap-2">
            <h2 className="px-1 text-sm font-semibold">{t('finances.checkTitle')}</h2>
            {!fixed.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noFixThisMonth')}</Card>}
            {fixed.map(f => <FixCheckRow key={f.id} f={f} month={month} t={t}
              onConfirmSuggestion={() => check.mutate({ fixed_cost_id: f.id, month, action: 'confirm', einkauf_id: f.suggestion!.source === 'receipt' ? f.suggestion!.einkauf_id : null, bank_tx_id: f.suggestion!.source === 'bank' ? f.suggestion!.bank_tx_id : null })}
              onConfirmNoReceipt={() => check.mutate({ fixed_cost_id: f.id, month, action: 'confirm' })}
              onSkip={() => check.mutate({ fixed_cost_id: f.id, month, action: 'skip' })}
              onClear={() => check.mutate({ fixed_cost_id: f.id, month, action: 'clear' })}
              onPick={() => setPicker(f)}
            />)}
          </div>

          {/* variable budgets */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-sm font-semibold">{t('finances.varTitle')}</h2>
              <Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setBudgetModal({})}>
                <Plus size={14} /> {t('finances.addBudget')}
              </Button>
            </div>
            {!budgets.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noBudgets')}</Card>}
            {budgets.map(b => <BudgetRow key={b.id} b={b} t={t} onEdit={() => setBudgetModal(b)} />)}
          </div>
        </>
      )}

      {picker && (
        <ReceiptPicker month={month} fix={picker} onClose={() => setPicker(null)}
          onPick={(einkaufId) => check.mutate({ fixed_cost_id: picker.id, month, action: 'confirm', einkauf_id: einkaufId })} />
      )}
      {budgetModal && <BudgetModal initial={budgetModal} onClose={() => setBudgetModal(null)} onSaved={invalidate} />}
    </div>
  );
}

function FixCheckRow({ f, t, onConfirmSuggestion, onConfirmNoReceipt, onSkip, onClear, onPick }: {
  f: MonthFix; month: string; t: (k: string, o?: Record<string, unknown>) => string;
  onConfirmSuggestion: () => void; onConfirmNoReceipt: () => void; onSkip: () => void; onClear: () => void; onPick: () => void;
}) {
  const autoOk = !f.check && f.expect_receipt === false;
  const delta = f.check?.amount != null ? Math.round((f.check.amount - f.monthly_eur) * 100) / 100 : null;
  const state: 'ok' | 'suggest' | 'open' = f.check || autoOk ? 'ok' : f.suggestion ? 'suggest' : 'open';
  const IconEl = state === 'ok' ? CheckCircle2 : state === 'suggest' ? CircleDot : Circle;
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2.5">
        <IconEl size={18} className={cn('shrink-0',
          state === 'ok' && (f.check?.status === 'skipped' ? 'text-zinc-400' : 'text-emerald-500'),
          state === 'suggest' && 'text-amber-500', state === 'open' && 'text-zinc-300 dark:text-zinc-600')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{f.label}</span>
            <span className="shrink-0 text-xs text-zinc-400">{scopeLabelOf(t, f)}</span>
          </div>
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {autoOk && t('finances.noReceiptAuto')}
            {f.check?.status === 'skipped' && t('finances.skippedMonth')}
            {f.check?.status === 'confirmed' && (f.check.source === 'none'
              ? t('finances.confirmedNoReceipt')
              : <>{f.check.source === 'bank' ? t('finances.bankShort') : t('finances.receiptShort')} {f.check.datum} „{f.check.laden}“ · {eur(f.check.amount)}{delta != null && Math.abs(delta) >= 0.01 && <span className={cn('ml-1', delta > 0 ? 'text-amber-600' : 'text-emerald-600')}>Δ {delta > 0 ? '+' : ''}{eur(delta)}</span>}</>)}
            {state === 'suggest' && f.suggestion && (
              <>{t('finances.suggestion')} „{f.suggestion.laden}“ {eur(f.suggestion.betrag)} · {f.suggestion.datum.slice(8, 10)}.{f.suggestion.datum.slice(5, 7)}.{f.suggestion.source === 'bank' && <Badge className="ml-1.5">{t('finances.bankBadge')}</Badge>}</>
            )}
            {state === 'open' && t('finances.noReceiptFound')}
          </div>
        </div>
        <span className="shrink-0 text-sm font-semibold">{eur(f.monthly_eur)}</span>
      </div>
      {(state !== 'ok' || f.check) && (
        <div className="flex flex-wrap gap-1.5 pl-7">
          {state === 'suggest' && <Button className="px-2.5 py-1 text-xs" onClick={onConfirmSuggestion}>{t('finances.confirm')}</Button>}
          {state !== 'ok' && <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={onPick}>{t('finances.chooseReceipt')}</Button>}
          {state !== 'ok' && f.expect_receipt !== false && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={onSkip}>{t('finances.skipThisMonth')}</Button>}
          {state !== 'ok' && f.expect_receipt !== false && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={onConfirmNoReceipt}>{t('finances.okNoReceipt')}</Button>}
          {f.check && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={onClear}>{t('finances.reopen')}</Button>}
        </div>
      )}
    </Card>
  );
}

function BudgetRow({ b, t, onEdit }: { b: MonthBudget; t: (k: string, o?: Record<string, unknown>) => string; onEdit: () => void }) {
  const pct = b.monthly_target > 0 ? (b.actual / b.monthly_target) * 100 : null;
  const barColor = pct == null ? 'bg-zinc-300' : pct > 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <Card className="flex flex-col gap-1.5 p-3">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{b.label}</span>
            <span className="shrink-0 text-xs text-zinc-400">{b.konto_id ? scopeLabelOf(t, b) : t('finances.wholeHousehold')}</span>
          </div>
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {t('finances.forecast')}: {b.forecast != null ? eur(b.forecast) : '–'} · {t('finances.target')}: {eur(b.monthly_target)}
          </div>
        </div>
        <span className={cn('shrink-0 text-sm font-semibold', pct != null && pct > 100 && 'text-red-600 dark:text-red-400')}>{eur(b.actual)}</span>
        <button onClick={onEdit} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" title={t('common.edit')}>
          <Pencil size={15} />
        </button>
      </div>
      {pct != null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
    </Card>
  );
}

/** Pick a receipt of the month as evidence for a fixed cost. */
function ReceiptPicker({ month, fix, onClose, onPick }: {
  month: string; fix: MonthFix; onClose: () => void; onPick: (einkaufId: number) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [y, mo] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  // Fixed costs are only ever backed by invoices (e-mail import or a dropped PDF),
  // never Kassenbons/cash — so the picker is scoped to those sources to match the
  // backend guard.
  const { data, isLoading } = useQuery({
    queryKey: ['fin-picker', month],
    queryFn: () => api<{ id: number; datum: string; roh_ladenname: string | null; gesamt_betrag: number | null }[]>(
      `/api/receipts?limit=200&from=${month}-01&to=${last}&quelle=email,upload`),
  });
  const rows = (data ?? []).filter(r => !q.trim() || (r.roh_ladenname ?? '').toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal open onClose={onClose} title={`${t('finances.pickerTitle')} · ${fix.label}`}>
      <div className="flex flex-col gap-2">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-8" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t('finances.pickerSearch')} />
        </div>
        {isLoading && <Spinner />}
        {!isLoading && !rows.length && <EmptyState>{t('finances.pickerEmpty')}</EmptyState>}
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {rows.map(r => (
            <button key={r.id} onClick={() => onPick(r.id)}
              className="flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-left hover:border-emerald-400 hover:bg-emerald-50/50 dark:border-zinc-800 dark:hover:bg-emerald-950/20">
              <span className="w-14 shrink-0 text-xs text-zinc-400">{r.datum?.slice(8, 10)}.{r.datum?.slice(5, 7)}.</span>
              <span className="min-w-0 flex-1 truncate text-sm">{r.roh_ladenname ?? '–'}</span>
              <span className="shrink-0 text-sm font-medium">{r.gesamt_betrag != null ? eur(r.gesamt_betrag) : '–'}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** Create/edit a budget: label, monthly target, optional konto scope, 1..n categories. */
function BudgetModal({ initial, onClose, onSaved }: {
  initial: Partial<MonthBudget>; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { data: konten } = useKonten();
  const scopeKonten = useMemo(() => (konten ?? []).filter(k => !k.is_cash), [konten]);
  const [label, setLabel] = useState(initial.label ?? '');
  const [target, setTarget] = useState(initial.monthly_target != null ? String(initial.monthly_target).replace('.', ',') : '');
  const [kontoId, setKontoId] = useState(initial.konto_id ? String(initial.konto_id) : '');
  const [cats, setCats] = useState<string[]>(initial.categories ?? []);

  const save = useMutation({
    mutationFn: () => {
      const body = { label: label.trim(), monthly_target: target, konto_id: kontoId ? Number(kontoId) : null, categories: cats };
      return initial.id
        ? api(`/api/budgets/${initial.id}`, { method: 'PATCH', body })
        : api('/api/budgets', { method: 'POST', body });
    },
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/budgets/${initial.id}`, { method: 'DELETE' }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <Modal open onClose={onClose} title={initial.id ? t('finances.editBudget') : t('finances.addBudgetTitle')}>
      <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); if (label.trim() && target && cats.length) save.mutate(); }}>
        <div>
          <Label>{t('finances.budgetLabel')}</Label>
          <Input autoFocus value={label} onChange={e => setLabel(e.target.value)} placeholder={t('finances.budgetLabelPlaceholder')} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('finances.target')}</Label>
            <Input inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} placeholder="0,00" />
          </div>
          <div>
            <Label>{t('finances.scope')}</Label>
            <Select value={kontoId} onChange={e => setKontoId(e.target.value)}>
              <option value="">{t('finances.wholeHousehold')}</option>
              {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
            </Select>
          </div>
        </div>
        <div>
          <Label>{t('finances.categoriesLabel')}</Label>
          {cats.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {cats.map(c => (
                <Badge key={c} className="inline-flex items-center gap-1">
                  {c.split('/').pop()}
                  <button type="button" onClick={() => setCats(cats.filter(x => x !== c))} className="text-zinc-400 hover:text-red-500" aria-label="×">
                    <X size={12} />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <CategoryPicker value={null} onChange={p => { if (p && !cats.includes(p)) setCats([...cats, p]); }} />
          <p className="mt-1 text-xs text-zinc-400">{t('finances.categoriesHint')}</p>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          {initial.id
            ? <Button type="button" variant="ghost" className="text-red-500" onClick={() => remove.mutate()}><Trash2 size={14} /> {t('common.delete')}</Button>
            : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!label.trim() || !target || !cats.length || save.isPending}>{t('common.save')}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ── management tab (fixed-cost master data) ─────────────────────────────────

type Draft = { id?: number; label: string; monthly_eur: string; konto_id: string; category_path: string | null; start_date: string; end_date: string; active: boolean; expect_receipt: boolean; match_merchant: string };
const emptyDraft = (kontoId?: number): Draft => ({
  label: '', monthly_eur: '', konto_id: kontoId ? String(kontoId) : '', category_path: null,
  start_date: today(), end_date: '', active: true, expect_receipt: true, match_merchant: '',
});

/** Upload one or more pay slips (DATEV etc.) → each is OCR'd and filed as an
 *  income row for the chosen account. Files upload sequentially with a per-file
 *  result line. Bank-statement CSV import is a separate (upcoming) evidence path. */
function PayslipUpload({ scopeKonten }: { scopeKonten: KontoLite[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [kontoId, setKontoId] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; text: string }[]>([]);

  // Default to the first personal (non-shared) account — a salary belongs to a person.
  const defaultKonto = useMemo(() => {
    const personal = scopeKonten.find(k => !k.is_shared);
    return String((personal ?? scopeKonten[0])?.id ?? '');
  }, [scopeKonten]);
  const effKonto = kontoId || defaultKonto;

  const readB64 = (file: File) => new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(file);
  });

  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    if (!effKonto) { toast(t('finances.income.pickAccount'), 'error'); return; }
    setBusy(true);
    const out: { name: string; ok: boolean; text: string }[] = [];
    for (const file of Array.from(list)) {
      try {
        const b64 = await readB64(file);
        const r = await api<{ ok: boolean; netto?: number; monat?: string; arbeitgeber?: string | null; reason?: string }>(
          '/api/finances/income/upload', { method: 'POST', body: { filename: file.name, data_b64: b64, konto_id: Number(effKonto) } });
        out.push(r.ok
          ? { name: file.name, ok: true, text: `${eur(r.netto!)} · ${r.monat ?? '?'}${r.arbeitgeber ? ' · ' + r.arbeitgeber : ''}` }
          : { name: file.name, ok: false, text: r.reason ?? t('finances.income.unreadable') });
      } catch (e) {
        out.push({ name: file.name, ok: false, text: (e as Error).message });
      }
      setResults([...out]);
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ['fin-month'] });
    void qc.invalidateQueries({ queryKey: ['fin-income'] });
    const n = out.filter(o => o.ok).length;
    if (n) toast(t('finances.income.importedToast', { n }), 'success');
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Upload size={16} className="text-emerald-600 dark:text-emerald-500" />
        <h2 className="text-base font-semibold">{t('finances.income.heading')}</h2>
      </div>
      <p className="text-xs text-zinc-500">{t('finances.income.intro')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[9rem] flex-1">
          <Label>{t('finances.income.account')}</Label>
          <Select value={effKonto} onChange={e => setKontoId(e.target.value)}>
            {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
          </Select>
        </div>
        <label className={cn(
          'inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700',
          busy && 'pointer-events-none opacity-50',
        )}>
          <Upload size={15} />
          {busy ? t('finances.income.working') : t('finances.income.choose')}
          <input type="file" accept="application/pdf,image/*" multiple className="hidden" disabled={busy}
            onChange={e => { void onFiles(e.target.files); e.target.value = ''; }} />
        </label>
      </div>
      {results.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          {results.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              {r.ok
                ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" />
                : <X size={14} className="mt-0.5 shrink-0 text-red-500" />}
              <span className="min-w-0 flex-1"><span className="text-zinc-400">{r.name}</span> — {r.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-zinc-400">{t('finances.income.hint')}</p>
    </Card>
  );
}

function ManageTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [modal, setModal] = useState<Draft | null>(null);

  const { data: costs, isLoading } = useQuery({ queryKey: ['fixed-costs'], queryFn: () => api<FixedCost[]>('/api/fixed-costs') });
  const { data: konten } = useKonten();

  // Scope options: every non-cash account. Shared = household (rent, loan…),
  // the rest = per person/account. Cash accounts don't carry standing costs.
  const scopeKonten = useMemo(() => (konten ?? []).filter(k => !k.is_cash), [konten]);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['fixed-costs'] });
    void qc.invalidateQueries({ queryKey: ['fin-month'] });
  };

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
        expect_receipt: d.expect_receipt,
        match_merchant: d.match_merchant.trim() || null,
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
      body: { label: c.label, monthly_eur: c.monthly_eur, konto_id: c.konto_id, category_path: c.category_path, start_date: c.start_date, end_date: c.end_date, active: c.active, expect_receipt: c.expect_receipt, match_merchant: c.match_merchant },
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

  if (isLoading || !konten) return <Spinner />;

  return (
    <div className="flex flex-col gap-4">
      <PayslipUpload scopeKonten={scopeKonten} />

      <div className="flex justify-end">
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
                {scopeLabelOf(t, g.konto)}
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
                      {!c.expect_receipt && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t('finances.noReceiptBadge')}</span>}
                      {!c.active && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t('finances.inactive')}</span>}
                      {c.end_date && <span>{t('finances.until')} {c.end_date}</span>}
                    </div>
                  </div>
                  <span className={cn('shrink-0 text-sm font-semibold', c.monthly_eur < 0 && 'text-sky-600 dark:text-sky-400')}>{eur(c.monthly_eur)}<span className="text-xs font-normal text-zinc-400">{t('finances.perMonth')}</span></span>
                  <button onClick={() => setModal({ id: c.id, label: c.label, monthly_eur: String(c.monthly_eur).replace('.', ','), konto_id: String(c.konto_id ?? ''), category_path: c.category_path, start_date: c.start_date, end_date: c.end_date ?? '', active: c.active, expect_receipt: c.expect_receipt, match_merchant: c.match_merchant ?? '' })}
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
                  {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
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
              <Switch checked={modal.expect_receipt} onChange={v => setModal({ ...modal, expect_receipt: v })} /> {t('finances.expectReceipt')}
            </label>
            <p className="-mt-2 pl-11 text-xs text-zinc-400">{t('finances.expectReceiptHint')}</p>
            {modal.expect_receipt && (
              <div>
                <Label>{t('finances.matchMerchant')} <span className="text-zinc-400">({t('common.optional')})</span></Label>
                <Input value={modal.match_merchant} onChange={e => setModal({ ...modal, match_merchant: e.target.value })} placeholder={t('finances.matchMerchantPlaceholder')} />
                <p className="mt-1 text-xs text-zinc-400">{t('finances.matchMerchantHint')}</p>
              </div>
            )}
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
