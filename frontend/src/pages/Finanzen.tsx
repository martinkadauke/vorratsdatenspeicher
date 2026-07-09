import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wallet, Plus, Pencil, Trash2, Home, User as UserIcon, Info,
  ChevronLeft, ChevronRight, ChevronDown, CheckCircle2, Circle, CircleDot, Search, X, Upload, Layers, Lock,
} from 'lucide-react';
import { api } from '../api/client';
import { Card, Spinner, Button, Input, Label, Select, Switch, Modal, EmptyState, Badge } from '../components/ui';
import { CategoryPicker } from '../components/CategoryPicker';
import { toast } from '../components/Toast';
import { eur, cn } from '../lib/utils';
import { useUrlState } from '../hooks/useUrlState';

// ── shared types ────────────────────────────────────────────────────────────

type Freq = 'monthly' | 'quarterly' | 'yearly';
const PERIOD_MONTHS: Record<Freq, number> = { monthly: 1, quarterly: 3, yearly: 12 };
// The per-month burden of a plan: monthly = full amount, quarterly = /3, yearly = /12.
const amortized = (eur: number, freq?: Freq | null) => eur / (PERIOD_MONTHS[(freq ?? 'monthly') as Freq] ?? 1);

interface FixedCost {
  id: number; label: string; category_path: string | null; monthly_eur: number; kind: 'expense' | 'income'; frequency: Freq; is_transfer: boolean;
  konto_id: number | null; start_date: string; end_date: string | null; active: boolean;
  expect_receipt: boolean; match_merchant: string | null;
  konto_name: string | null; is_shared: boolean | null; konto_user_id: number | null; owner: string | null;
}
interface KontoLite { id: number; name: string; is_shared: boolean; is_cash: boolean; user_id: number | null; owner: string | null; owner_name: string | null }

interface MonthFix {
  id: number; label: string; monthly_eur: number; kind: 'expense' | 'income'; frequency: Freq; is_transfer: boolean; expect_receipt: boolean; match_merchant: string | null;
  konto_id: number | null; konto_name: string | null; is_shared: boolean | null; owner: string | null;
  check: { status: 'confirmed' | 'skipped'; source: 'receipt' | 'bank' | 'income' | 'none'; einkauf_id: number | null; bank_tx_id: number | null; income_id: number | null; amount: number | null; laden: string | null; datum: string | null } | null;
  suggestion: { source: 'receipt' | 'bank' | 'income'; einkauf_id: number | null; bank_tx_id: number | null; income_id: number | null; laden: string | null; betrag: number; datum: string; amount_ok: boolean; merchant_ok: boolean } | null;
}
interface MonthBudget {
  id: number; label: string; monthly_target: number; konto_id: number | null;
  konto_name: string | null; is_shared: boolean | null; owner: string | null;
  categories: string[]; actual: number; forecast: number | null;
}
interface MonthIncome {
  id: number; datum: string; amount: number; source: string; description: string | null;
  konto_id: number | null; konto_name: string | null; is_shared: boolean | null; owner: string | null;
}
interface MonthData { month: string; income: MonthIncome[]; incomes: MonthFix[]; fixed: MonthFix[]; budgets: MonthBudget[] }

const today = () => new Date().toISOString().slice(0, 10);
const curMonth = () => new Date().toISOString().slice(0, 7);
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const shiftMonth = (m: string, d: number) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1 + d, 1)).toISOString().slice(0, 7);
};

function useKonten() {
  return useQuery({ queryKey: ['konten'], queryFn: () => api<KontoLite[]>('/api/konten') });
}
// Shared "Haushaltskonto" → "Haushalt"; other shared accounts keep their name;
// personal accounts show the owner, else the account name.
function scopeLabelOf(t: (k: string) => string, k: { is_shared?: boolean | null; name?: string | null; owner?: string | null; owner_name?: string | null; konto_name?: string | null } | undefined | null): string {
  if (!k) return '?';
  const name = (k as { name?: string | null }).name ?? (k as { konto_name?: string | null }).konto_name ?? '';
  if (k.is_shared) return /haushalt/i.test(name ?? '') ? t('finances.household') : (name ?? '?');
  // Prefer the linked household member's name over the raw username.
  return k.owner_name ?? k.owner ?? name ?? '?';
}

/** Collapsible section with a chevron header (month-view groups). */
function Section({ title, count, right, defaultOpen = true, children }: {
  title: string; count?: number; right?: ReactNode; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-sm font-semibold">
          <ChevronDown size={15} className={cn('shrink-0 text-zinc-400 transition-transform', !open && '-rotate-90')} />
          {title}{count != null && <span className="font-normal text-zinc-400">· {count}</span>}
        </button>
        {right}
      </div>
      {open && children}
    </div>
  );
}

/** Pill toggle for the account-holder / account scope filter. */
function ScopeBubble({ active, small, onClick, children }: { active: boolean; small?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={cn(
      'shrink-0 rounded-full border font-medium transition-colors',
      small ? 'px-2.5 py-0.5 text-[11px]' : 'px-3 py-1 text-xs',
      active ? 'border-transparent bg-violet-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400',
    )}>{children}</button>
  );
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
  const [posBudget, setPosBudget] = useState<MonthBudget | null>(null);

  // Account-holder scope: one bubble per person + one for the household account;
  // default = all (Gesamthaushalt). Selecting a single person reveals sub-bubbles
  // for that person's accounts (subtractive). The chosen konto_ids scope the view,
  // which makes internal transfers (Beiträge) net out in the whole-household view.
  const { data: konten } = useKonten();
  const scope = useMemo(() => {
    const nonCash = (konten ?? []).filter(k => !k.is_cash);
    const memberMap = new Map<number, { key: string; label: string; konten: KontoLite[] }>();
    const household: KontoLite[] = [];
    for (const k of nonCash) {
      if (k.is_shared) household.push(k);
      else if (k.user_id != null) {
        if (!memberMap.has(k.user_id)) memberMap.set(k.user_id, { key: `u${k.user_id}`, label: k.owner_name ?? k.owner ?? k.name, konten: [] });
        memberMap.get(k.user_id)!.konten.push(k);
      }
    }
    const members = [...memberMap.values()].sort((a, b) => a.label.localeCompare(b.label));
    const allKeys = [...members.map(m => m.key), ...(household.length ? ['household'] : [])];
    return { members, household, allKeys };
  }, [konten]);
  const [selKeys, setSelKeys] = useState<Set<string> | null>(null);   // null = all
  const [exclKonten, setExclKonten] = useState<Set<number>>(new Set());
  const activeKeys = selKeys ?? new Set(scope.allKeys);
  const soleMember = activeKeys.size === 1 ? scope.members.find(m => activeKeys.has(m.key)) : undefined;
  const effKonten = useMemo(() => {
    const ids: number[] = [];
    for (const m of scope.members) if (activeKeys.has(m.key)) ids.push(...m.konten.map(k => k.id));
    if (scope.household.length && activeKeys.has('household')) ids.push(...scope.household.map(k => k.id));
    return ids.filter(id => !exclKonten.has(id));
  }, [scope, activeKeys, exclKonten]);
  const isAll = !selKeys && exclKonten.size === 0;
  const toggleGroup = (key: string) => {
    const next = new Set(activeKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    setExclKonten(new Set());
    setSelKeys(next.size === 0 || next.size === scope.allKeys.length ? null : next);
  };
  const toggleKonto = (id: number) => setExclKonten(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const kontenParam = isAll ? '' : `&konten=${effKonten.join(',')}`;

  const { data, isLoading } = useQuery({
    queryKey: ['fin-month', month, isAll ? 'all' : effKonten.join(',')],
    queryFn: () => api<MonthData>(`/api/finances/month?month=${month}${kontenParam}`),
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['fin-month'] });

  const check = useMutation({
    mutationFn: (b: { fixed_cost_id: number; month: string; action: 'confirm' | 'skip' | 'clear'; einkauf_id?: number | null; bank_tx_id?: number | null; income_id?: number | null }) =>
      api('/api/finances/check', { method: 'POST', body: b }),
    onSuccess: () => { invalidate(); setPicker(null); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(
    i18n.language === 'en' ? 'en-GB' : 'de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const incomes = data?.incomes ?? [];   // recurring income PLANS (Einnahmen-Soll)
  const fixed = data?.fixed ?? [];
  const budgets = data?.budgets ?? [];
  // Summary mirrors fixed costs: sum the PLANS (Soll), not just the matched actuals.
  // Internal transfers (Umbuchung) net to zero across the household, so they're
  // excluded from the gross totals in the whole-household view; in a single-account
  // scope only one leg is present, so they count (Martin −2000 / Haushalt +2000).
  const counts = (f: MonthFix) => !isAll || !f.is_transfer;
  const incomeTotal = incomes.reduce((s, f) => s + (counts(f) ? amortized(f.monthly_eur, f.frequency) : 0), 0);
  const fixTotal = fixed.reduce((s, f) => s + (counts(f) ? amortized(f.monthly_eur, f.frequency) : 0), 0);
  const isOk = (f: MonthFix) => !!f.check || f.expect_receipt === false;
  const okCount = fixed.filter(isOk).length;
  const varActual = budgets.reduce((s, b) => s + b.actual, 0);
  const varTarget = budgets.reduce((s, b) => s + b.monthly_target, 0);
  const net = Math.round((incomeTotal - fixTotal - varActual) * 100) / 100;

  // Confirm the auto-suggestion, passing the id of whichever evidence kind it is.
  const confirmSug = (f: MonthFix) => check.mutate({
    fixed_cost_id: f.id, month, action: 'confirm',
    einkauf_id: f.suggestion!.source === 'receipt' ? f.suggestion!.einkauf_id : null,
    bank_tx_id: f.suggestion!.source === 'bank' ? f.suggestion!.bank_tx_id : null,
    income_id: f.suggestion!.source === 'income' ? f.suggestion!.income_id : null,
  });

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

      {/* account-holder scope bubbles (person(s) + household; default all) */}
      {scope.allKeys.length > 1 && (
        <div className="flex flex-col items-center gap-1.5">
          <div className="flex flex-wrap justify-center gap-1.5">
            {scope.members.map(m => (
              <ScopeBubble key={m.key} active={activeKeys.has(m.key)} onClick={() => toggleGroup(m.key)}>{m.label}</ScopeBubble>
            ))}
            {scope.household.length > 0 && (
              <ScopeBubble active={activeKeys.has('household')} onClick={() => toggleGroup('household')}>{t('finances.household')}</ScopeBubble>
            )}
          </div>
          {soleMember && soleMember.konten.length > 1 && (
            <div className="flex flex-wrap justify-center gap-1.5">
              {soleMember.konten.map(k => (
                <ScopeBubble key={k.id} small active={!exclKonten.has(k.id)} onClick={() => toggleKonto(k.id)}>{k.name}</ScopeBubble>
              ))}
            </div>
          )}
        </div>
      )}

      {isLoading && <Spinner />}
      {data && (
        <>
          <Card className="flex flex-col gap-3 p-4">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">{t('finances.incomeTitle')}</div>
                <div className="text-lg font-bold text-emerald-600 dark:text-emerald-500">{eur(incomeTotal)}</div>
              </div>
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
            </div>
            <div className="flex items-center justify-between border-t border-zinc-100 pt-2 dark:border-zinc-800">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('finances.netTitle')}</span>
              <span className={cn('text-base font-bold', net >= 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-red-500')}>{net >= 0 ? '+' : ''}{eur(net)}</span>
            </div>
          </Card>

          {/* income plans (Einnahmen) — each shows its matched actual pay-slip / bank credit as evidence */}
          <Section title={t('finances.incomeTitle')} count={incomes.length}>
            {!incomes.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noIncomePlans')}</Card>}
            {incomes.map(f => <FixCheckRow key={f.id} f={f} month={month} t={t} excluded={isAll && f.is_transfer}
              onConfirmSuggestion={() => confirmSug(f)}
              onConfirmNoReceipt={() => check.mutate({ fixed_cost_id: f.id, month, action: 'confirm' })}
              onSkip={() => check.mutate({ fixed_cost_id: f.id, month, action: 'skip' })}
              onClear={() => check.mutate({ fixed_cost_id: f.id, month, action: 'clear' })}
              onPick={() => setPicker(f)}
            />)}
          </Section>

          {/* fixed costs */}
          <Section title={t('finances.fixTitle')} count={fixed.length}>
            {!fixed.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noFixThisMonth')}</Card>}
            {fixed.map(f => <FixCheckRow key={f.id} f={f} month={month} t={t} excluded={isAll && f.is_transfer}
              onConfirmSuggestion={() => confirmSug(f)}
              onConfirmNoReceipt={() => check.mutate({ fixed_cost_id: f.id, month, action: 'confirm' })}
              onSkip={() => check.mutate({ fixed_cost_id: f.id, month, action: 'skip' })}
              onClear={() => check.mutate({ fixed_cost_id: f.id, month, action: 'clear' })}
              onPick={() => setPicker(f)}
            />)}
          </Section>

          {/* variable budgets */}
          <Section title={t('finances.varTitle')} count={budgets.length}
            right={<Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setBudgetModal({})}><Plus size={14} /> {t('finances.addBudget')}</Button>}>
            {!budgets.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noBudgets')}</Card>}
            {budgets.map(b => <BudgetRow key={b.id} b={b} t={t} onEdit={() => setBudgetModal(b)} onOpen={() => setPosBudget(b)} />)}
          </Section>
        </>
      )}

      {picker && (
        <ReceiptPicker month={month} fix={picker} onClose={() => setPicker(null)}
          onPick={(ev) => check.mutate({ fixed_cost_id: picker.id, month, action: 'confirm', ...ev })} />
      )}
      {budgetModal && <BudgetModal initial={budgetModal} onClose={() => setBudgetModal(null)} onSaved={invalidate} />}
      {posBudget && <BudgetPositions budget={posBudget} month={month} onClose={() => setPosBudget(null)} />}
    </div>
  );
}

function FixCheckRow({ f, t, excluded, onConfirmSuggestion, onConfirmNoReceipt, onSkip, onClear, onPick }: {
  f: MonthFix; month: string; t: (k: string, o?: Record<string, unknown>) => string; excluded?: boolean;
  onConfirmSuggestion: () => void; onConfirmNoReceipt: () => void; onSkip: () => void; onClear: () => void; onPick: () => void;
}) {
  const autoOk = !f.check && f.expect_receipt === false;
  const delta = f.check?.amount != null ? Math.round((f.check.amount - f.monthly_eur) * 100) / 100 : null;
  const periodic = f.frequency && f.frequency !== 'monthly';
  const shownAmount = periodic ? amortized(f.monthly_eur, f.frequency) : f.monthly_eur;
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
            {f.is_transfer && <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{t('finances.transferBadge')}</span>}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {autoOk && t('finances.noReceiptAuto')}
            {f.check?.status === 'skipped' && t('finances.skippedMonth')}
            {f.check?.status === 'confirmed' && (f.check.source === 'none'
              ? t('finances.confirmedNoReceipt')
              : <>{f.check.source === 'bank' ? t('finances.bankShort') : f.check.source === 'income' ? t('finances.incomeShort') : t('finances.receiptShort')} {f.check.datum} „{f.check.laden}“ · {eur(f.check.amount)}{delta != null && Math.abs(delta) >= 0.01 && <span className={cn('ml-1', delta > 0 ? 'text-amber-600' : 'text-emerald-600')}>Δ {delta > 0 ? '+' : ''}{eur(delta)}</span>}</>)}
            {state === 'suggest' && f.suggestion && (
              <>{t('finances.suggestion')} „{f.suggestion.laden}“ {eur(f.suggestion.betrag)} · {f.suggestion.datum.slice(8, 10)}.{f.suggestion.datum.slice(5, 7)}.{f.suggestion.source === 'bank' && <Badge className="ml-1.5">{t('finances.bankBadge')}</Badge>}</>
            )}
            {state === 'open' && (f.kind === 'income' ? t('finances.noIncomeFound') : t('finances.noReceiptFound'))}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn('text-sm font-semibold', excluded && 'text-zinc-400 line-through')}>{eur(shownAmount)}</div>
          {periodic && <div className="text-[10px] text-zinc-400">{eur(f.monthly_eur)} {t(`finances.freqPer.${f.frequency}`)}</div>}
          {excluded && <div className="text-[10px] text-violet-500">{t('finances.notCounted')}</div>}
        </div>
      </div>
      {(state !== 'ok' || f.check) && (
        <div className="flex flex-wrap gap-1.5 pl-7">
          {state === 'suggest' && <Button className="px-2.5 py-1 text-xs" onClick={onConfirmSuggestion}>{t('finances.confirm')}</Button>}
          {state !== 'ok' && <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={onPick}>{f.kind === 'income' ? t('finances.chooseIncome') : t('finances.chooseReceipt')}</Button>}
          {state !== 'ok' && f.expect_receipt !== false && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={onSkip}>{t('finances.skipThisMonth')}</Button>}
          {state !== 'ok' && f.expect_receipt !== false && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={onConfirmNoReceipt}>{t('finances.okNoReceipt')}</Button>}
          {f.check && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={onClear}>{t('finances.reopen')}</Button>}
        </div>
      )}
    </Card>
  );
}

function BudgetRow({ b, t, onEdit, onOpen }: { b: MonthBudget; t: (k: string, o?: Record<string, unknown>) => string; onEdit: () => void; onOpen: () => void }) {
  const pct = b.monthly_target > 0 ? (b.actual / b.monthly_target) * 100 : null;
  const barColor = pct == null ? 'bg-zinc-300' : pct > 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <Card
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title={t('finances.showPositions')}
      className="flex cursor-pointer flex-col gap-1.5 p-3 transition-colors hover:border-emerald-300 hover:bg-emerald-50/40 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/20"
    >
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
        <button onClick={e => { e.stopPropagation(); onEdit(); }} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" title={t('common.edit')}>
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

interface BudgetPos {
  id: number; name: string | null; preis: number; menge: number | null; einheit: string | null;
  category_path: string | null; einkauf_id: number | null; datum: string | null; laden: string | null;
  private?: boolean;
}
type PosSort = 'date_desc' | 'date_asc' | 'price_desc' | 'price_asc';

// Group a position under the first sub-category below the budget's matched base
// category (budget "Lebensmittel" → groups "Obst & Gemüse", "Milch & Eier", …).
function catGroupOf(catPath: string, bases: string[]): { key: string; label: string } {
  const base = bases.filter(b => catPath === b || catPath.startsWith(b + '/')).sort((a, b) => b.length - a.length)[0];
  if (base == null) return { key: catPath || '—', label: (catPath.split('/').pop() || '—') };
  if (catPath === base) return { key: base, label: (base.split('/').pop() || base) };
  const firstSeg = catPath.slice(base.length + 1).split('/')[0];
  return { key: `${base}/${firstSeg}`, label: firstSeg };
}
const sortPositions = (rs: BudgetPos[], sort: PosSort) => [...rs].sort((a, b) => {
  const ad = a.datum ?? '', bd = b.datum ?? '';
  return sort === 'date_asc' ? (ad < bd ? -1 : ad > bd ? 1 : a.id - b.id)
    : sort === 'date_desc' ? (ad > bd ? -1 : ad < bd ? 1 : b.id - a.id)
      : sort === 'price_asc' ? a.preis - b.preis : b.preis - a.preis;
});

/** One position row. A masked (private) position shows only "Privater Einkauf" +
 *  its amount — no name, store, category, date, and not clickable. Otherwise the
 *  row jumps to its receipt with the item highlighted. */
function PosRow({ p, t, onOpen }: { p: BudgetPos; t: (k: string, o?: Record<string, unknown>) => string; onOpen: (p: BudgetPos) => void }) {
  if (p.private) {
    return (
      <li className="flex items-center gap-2 px-1 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm italic text-zinc-500 dark:text-zinc-400">
          <Lock size={13} className="shrink-0" />
          <span className="truncate">{t('finances.privatePurchase')}</span>
        </div>
        <span className="shrink-0 text-sm font-semibold">{eur(p.preis)}</span>
      </li>
    );
  }
  return (
    <li onClick={() => onOpen(p)} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p); } }}
      title={t('finances.openReceipt')}
      className="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{p.name}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
          {p.datum && <span>{ddmmyyyy(p.datum)}</span>}
          {p.laden && <span className="truncate">{p.laden}</span>}
          {p.category_path && <span className="truncate text-zinc-400">{p.category_path.split('/').pop()}</span>}
        </div>
      </div>
      <span className="shrink-0 text-sm font-semibold">{eur(p.preis)}</span>
      <ChevronRight size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />
    </li>
  );
}

/** A collapsible sub-category group; the header shows its total for the month. */
function CatGroup({ g, t, onOpen }: { g: { key: string; label: string; total: number; items: BudgetPos[] }; t: (k: string, o?: Record<string, unknown>) => string; onOpen: (p: BudgetPos) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="overflow-hidden rounded-lg border border-zinc-100 dark:border-zinc-800">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
        <ChevronDown size={14} className={cn('shrink-0 text-zinc-400 transition-transform', !open && '-rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.label}</span>
        <span className="shrink-0 text-xs text-zinc-400">{g.items.length}</span>
        <span className="shrink-0 text-sm font-semibold">{eur(g.total)}</span>
      </button>
      {open && (
        <ul className="border-t border-zinc-100 px-1 dark:border-zinc-800">
          {g.items.map(p => <PosRow key={p.id} p={p} t={t} onOpen={onOpen} />)}
        </ul>
      )}
    </li>
  );
}

/** Drill-down modal: every article position that makes up this budget's actual
 *  (Ist) for the month. The list total equals the Ist shown on the budget tile —
 *  the backend reuses the same query. Positions can be sorted (date / price) and
 *  grouped into the budget's sub-categories with per-group totals. */
function BudgetPositions({ budget, month, onClose }: { budget: MonthBudget; month: string; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sort, setSort] = useState<PosSort>('date_desc');
  const [grouped, setGrouped] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['budget-positions', budget.id, month],
    queryFn: () => api<{ positions: BudgetPos[]; total: number }>(`/api/finances/budget/${budget.id}/positions?month=${month}`),
  });
  const rows = data?.positions ?? [];
  // Masked (private) positions carry no einkauf_id → not navigable.
  const openReceipt = (p: BudgetPos) => { if (p.private || !p.einkauf_id) return; onClose(); navigate(`/receipts/${p.einkauf_id}?highlight=${p.id}`); };
  const sorted = useMemo(() => sortPositions(rows, sort), [rows, sort]);
  const groups = useMemo(() => {
    const bases = budget.categories ?? [];
    const map = new Map<string, { label: string; items: BudgetPos[]; total: number }>();
    for (const p of rows) {
      // Private positions have no category → collect them in one "Privater Einkauf" group.
      const g = p.private ? { key: '__private__', label: t('finances.privatePurchase') } : catGroupOf(p.category_path ?? '', bases);
      const e = map.get(g.key) ?? { label: g.label, items: [] as BudgetPos[], total: 0 };
      e.items.push(p); e.total += p.preis;
      map.set(g.key, e);
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, label: v.label, total: Math.round(v.total * 100) / 100, items: sortPositions(v.items, sort) }))
      .sort((a, b) => b.total - a.total);
  }, [rows, sort, budget.categories]);

  return (
    <Modal open onClose={onClose} title={budget.label}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">{t('finances.positionsCount', { count: rows.length })}</span>
          <span className="font-semibold">{eur(data?.total ?? 0)}</span>
        </div>
        {rows.length > 0 && (
          <div className="flex items-center gap-2">
            <Select value={sort} onChange={e => setSort(e.target.value as PosSort)} className="min-w-0 flex-1 text-xs">
              <option value="date_desc">{t('finances.sortDateDesc')}</option>
              <option value="date_asc">{t('finances.sortDateAsc')}</option>
              <option value="price_desc">{t('finances.sortPriceDesc')}</option>
              <option value="price_asc">{t('finances.sortPriceAsc')}</option>
            </Select>
            <button onClick={() => setGrouped(g => !g)}
              className={cn('inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium',
                grouped ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300')}>
              <Layers size={14} /> {t('finances.groupByCat')}
            </button>
          </div>
        )}
        {isLoading ? <Spinner /> : rows.length === 0 ? (
          <p className="py-4 text-center text-xs text-zinc-400">{t('finances.positionsEmpty')}</p>
        ) : grouped ? (
          <ul className="-mx-1 flex max-h-[60vh] flex-col gap-1 overflow-y-auto px-1">
            {groups.map(g => <CatGroup key={g.key} g={g} t={t} onOpen={openReceipt} />)}
          </ul>
        ) : (
          <ul className="-mx-1 flex max-h-[60vh] flex-col divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
            {sorted.map(p => <PosRow key={p.id} p={p} t={t} onOpen={openReceipt} />)}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/** Pick a receipt of the month as evidence for a fixed cost. */
type PickEv = { einkauf_id?: number; income_id?: number; bank_tx_id?: number };
/** Manual evidence picker. For an expense plan it lists the month's invoices
 *  (e-mail/upload). For an income plan it lists income evidence — pay-slip rows
 *  and bank credits — from /income-evidence. onPick returns the id of the chosen
 *  evidence kind. */
function ReceiptPicker({ month, fix, onClose, onPick }: {
  month: string; fix: MonthFix; onClose: () => void; onPick: (ev: PickEv) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [y, mo] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  const isIncome = fix.kind === 'income';

  const receiptsQ = useQuery({
    queryKey: ['fin-picker', 'receipt', month],
    queryFn: () => api<{ id: number; datum: string; roh_ladenname: string | null; gesamt_betrag: number | null }[]>(
      `/api/receipts?limit=200&from=${month}-01&to=${last}&quelle=email,upload`),
    enabled: !isIncome,
  });
  const incomeQ = useQuery({
    queryKey: ['fin-picker', 'income', month],
    queryFn: () => api<{ items: { source: 'income' | 'bank'; id: number; datum: string; amount: number; label: string }[] }>(
      `/api/finances/income-evidence?month=${month}`),
    enabled: isIncome,
  });
  const isLoading = isIncome ? incomeQ.isLoading : receiptsQ.isLoading;

  type Row = { key: string; datum: string | null; label: string; amount: number | null; ev: PickEv };
  const all: Row[] = isIncome
    ? (incomeQ.data?.items ?? []).map(i => ({ key: `${i.source}:${i.id}`, datum: i.datum, label: i.label, amount: i.amount, ev: i.source === 'income' ? { income_id: i.id } : { bank_tx_id: i.id } }))
    : (receiptsQ.data ?? []).map(r => ({ key: `r:${r.id}`, datum: r.datum, label: r.roh_ladenname ?? '–', amount: r.gesamt_betrag, ev: { einkauf_id: r.id } }));
  const rows = all.filter(r => !q.trim() || r.label.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <Modal open onClose={onClose} title={`${t(isIncome ? 'finances.incomePickerTitle' : 'finances.pickerTitle')} · ${fix.label}`}>
      <div className="flex flex-col gap-2">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-8" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t('finances.pickerSearch')} />
        </div>
        {isLoading && <Spinner />}
        {!isLoading && !rows.length && <EmptyState>{t(isIncome ? 'finances.incomePickerEmpty' : 'finances.pickerEmpty')}</EmptyState>}
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {rows.map(r => (
            <button key={r.key} onClick={() => onPick(r.ev)}
              className="flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-left hover:border-emerald-400 hover:bg-emerald-50/50 dark:border-zinc-800 dark:hover:bg-emerald-950/20">
              <span className="w-14 shrink-0 text-xs text-zinc-400">{r.datum?.slice(8, 10)}.{r.datum?.slice(5, 7)}.</span>
              <span className="min-w-0 flex-1 truncate text-sm">{r.label}</span>
              <span className="shrink-0 text-sm font-medium">{r.amount != null ? eur(r.amount) : '–'}</span>
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

type Draft = { id?: number; label: string; monthly_eur: string; kind: 'expense' | 'income'; frequency: Freq; is_transfer: boolean; konto_id: string; category_path: string | null; start_date: string; end_date: string; active: boolean; expect_receipt: boolean; match_merchant: string };
const emptyDraft = (kontoId?: number, kind: 'expense' | 'income' = 'expense'): Draft => ({
  label: '', monthly_eur: '', kind, frequency: 'monthly', is_transfer: false, konto_id: kontoId ? String(kontoId) : '', category_path: null,
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

// ── Erfasste Einnahmen (actual income rows: pay slips / CSV credits) ──────────
interface IncomeEntry {
  id: number; datum: string; amount: number; source: string; description: string | null;
  konto_id: number | null; konto_name: string | null; is_shared: boolean | null;
  owner: string | null; owner_name: string | null;
}

function IncomeList() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['fin-income'],
    queryFn: () => api<{ income: IncomeEntry[] }>('/api/finances/income'),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/finances/income/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fin-income'] });
      void qc.invalidateQueries({ queryKey: ['fin-month'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const srcLabel = (s: string) => t(`finances.income.src.${s}`, { defaultValue: s });

  const rows = data?.income ?? [];
  const total = rows.reduce((s, r) => s + r.amount, 0);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet size={16} className="text-emerald-600 dark:text-emerald-500" />
          <h2 className="text-base font-semibold">{t('finances.income.listHeading')}</h2>
        </div>
        {rows.length > 0 && (
          <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-500">+{eur(total)}</span>
        )}
      </div>
      {isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-xs text-zinc-400">{t('finances.income.listEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map(r => (
            <li key={r.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{r.description || t('finances.income.entryFallback')}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{ddmmyyyy(r.datum)}</span>
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">{srcLabel(r.source)}</span>
                  {r.konto_id && <span className="truncate">{scopeLabelOf(t, r)}</span>}
                </div>
              </div>
              <span className="shrink-0 text-sm font-semibold text-emerald-600 dark:text-emerald-500">+{eur(r.amount)}</span>
              <button
                onClick={() => remove.mutate(r.id)}
                className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
                title={t('common.delete')}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
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
        kind: d.kind,
        frequency: d.frequency,
        is_transfer: d.is_transfer,
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
      body: { label: c.label, monthly_eur: c.monthly_eur, kind: c.kind, frequency: c.frequency, is_transfer: c.is_transfer, konto_id: c.konto_id, category_path: c.category_path, start_date: c.start_date, end_date: c.end_date, active: c.active, expect_receipt: c.expect_receipt, match_merchant: c.match_merchant },
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

  // Household-wide total excludes internal transfers (Umbuchung) — they aren't real spend.
  const monthlyTotal = (costs ?? []).filter(c => c.active && c.kind !== 'income' && !c.is_transfer).reduce((s, c) => s + amortized(c.monthly_eur, c.frequency), 0);

  if (isLoading || !konten) return <Spinner />;

  return (
    <div className="flex flex-col gap-4">
      <PayslipUpload scopeKonten={scopeKonten} />
      <IncomeList />

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
        const sum = g.items.filter(c => c.active && c.kind !== 'income').reduce((s, c) => s + amortized(c.monthly_eur, c.frequency), 0);
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
                      {c.kind === 'income' && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">{t('finances.incomeTitle')}</span>}
                      {c.is_transfer && <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{t('finances.transferBadge')}</span>}
                      {c.frequency !== 'monthly' && <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">{t(`finances.freq.${c.frequency}`)} · {eur(c.monthly_eur)}</span>}
                      {c.category_path && <span className="truncate">{c.category_path.split('/').pop()}</span>}
                      {!c.expect_receipt && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t('finances.noReceiptBadge')}</span>}
                      {!c.active && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t('finances.inactive')}</span>}
                      {c.end_date && <span>{t('finances.until')} {c.end_date}</span>}
                    </div>
                  </div>
                  <span className={cn('shrink-0 text-sm font-semibold', c.kind === 'income' && 'text-emerald-600 dark:text-emerald-500')}>{c.kind === 'income' ? '+' : ''}{eur(amortized(c.monthly_eur, c.frequency))}<span className="text-xs font-normal text-zinc-400">{t('finances.perMonth')}</span></span>
                  <button onClick={() => setModal({ id: c.id, label: c.label, monthly_eur: String(c.monthly_eur).replace('.', ','), kind: c.kind, frequency: c.frequency, is_transfer: c.is_transfer, konto_id: String(c.konto_id ?? ''), category_path: c.category_path, start_date: c.start_date, end_date: c.end_date ?? '', active: c.active, expect_receipt: c.expect_receipt, match_merchant: c.match_merchant ?? '' })}
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
            <div className="flex gap-1.5">
              {(['expense', 'income'] as const).map(k => (
                <button key={k} type="button" onClick={() => setModal({ ...modal, kind: k })}
                  className={cn('flex-1 rounded-xl border px-3 py-2 text-sm font-medium',
                    modal.kind === k ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>
                  {k === 'income' ? t('finances.incomeTitle') : t('finances.fixTitle')}
                </button>
              ))}
            </div>
            <div>
              <Label>{t('finances.label')}</Label>
              <Input autoFocus value={modal.label} onChange={e => setModal({ ...modal, label: e.target.value })} placeholder={t('finances.labelPlaceholder')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('finances.amount')}</Label>
                <Input inputMode="decimal" value={modal.monthly_eur} onChange={e => setModal({ ...modal, monthly_eur: e.target.value })} placeholder="0,00" />
                {modal.frequency !== 'monthly' && modal.monthly_eur && (
                  <p className="mt-1 text-[11px] text-zinc-400">{t('finances.amortizedHint', { v: eur(amortized(parseFloat(modal.monthly_eur.replace(',', '.')) || 0, modal.frequency)) })}</p>
                )}
              </div>
              <div>
                <Label>{t('finances.frequency')}</Label>
                <Select value={modal.frequency} onChange={e => setModal({ ...modal, frequency: e.target.value as Freq })}>
                  <option value="monthly">{t('finances.freq.monthly')}</option>
                  <option value="quarterly">{t('finances.freq.quarterly')}</option>
                  <option value="yearly">{t('finances.freq.yearly')}</option>
                </Select>
              </div>
            </div>
            <div>
              <Label>{t('finances.scope')}</Label>
              <Select value={modal.konto_id} onChange={e => setModal({ ...modal, konto_id: e.target.value })}>
                <option value="" disabled>–</option>
                {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
              </Select>
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
              <Switch checked={modal.is_transfer} onChange={v => setModal({ ...modal, is_transfer: v })} /> {t('finances.transferLabel')}
            </label>
            <p className="-mt-2 pl-11 text-xs text-zinc-400">{t('finances.transferHint')}</p>
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
