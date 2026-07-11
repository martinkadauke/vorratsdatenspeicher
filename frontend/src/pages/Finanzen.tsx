import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wallet, Plus, Pencil, Trash2, Home, User as UserIcon, Info,
  ChevronLeft, ChevronRight, ChevronDown, CheckCircle2, Circle, CircleDot, AlertCircle, Search, X, Upload, Layers, Lock,
  Link2, Link2Off, RefreshCw, Landmark, SlidersHorizontal, Flag, FilePlus2, Receipt, FileText, Paperclip, Sparkles, Calendar, ExternalLink,
} from 'lucide-react';
import { api, getToken } from '../api/client';
import { Card, Spinner, Button, Input, Label, Select, Switch, Modal, EmptyState, Badge } from '../components/ui';
import { CategoryPicker } from '../components/CategoryPicker';
import { toast } from '../components/Toast';
import { confirm } from '../components/Confirm';
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
  counterpart_id: number | null; counterpart_label: string | null; counterpart_konto: string | null;
  konto_name: string | null; is_shared: boolean | null; konto_user_id: number | null; owner: string | null;
}
interface KontoLite { id: number; name: string; is_shared: boolean; is_cash: boolean; user_id: number | null; owner: string | null; owner_name: string | null }

interface MonthFix {
  id: number; label: string; monthly_eur: number; kind: 'expense' | 'income'; frequency: Freq; is_transfer: boolean; expect_receipt: boolean; match_merchant: string | null;
  one_off: boolean;
  konto_id: number | null; konto_name: string | null; is_shared: boolean | null; owner: string | null;
  complete: boolean; bank_linked: boolean;
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
          {([['monat', 'finances.monthTab'], ['bank', 'finances.bankTab'], ['verwaltung', 'finances.manageTab']] as const).map(([tb, key]) => (
            <button key={tb} onClick={() => setTab(tb)}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                tab === tb ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300')}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>
      {tab === 'verwaltung' ? <ManageTab /> : tab === 'bank' ? <BankTab /> : <MonthTab />}
    </div>
  );
}

// ── month view ──────────────────────────────────────────────────────────────

function MonthTab() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [month, setMonth] = useUrlState('m', curMonth());
  const [fx, setFx] = useUrlState('fx', '');   // deep-link from Auszüge: open this plan's evidence
  const [picker, setPicker] = useState<MonthFix | null>(null);
  const [budgetModal, setBudgetModal] = useState<Partial<MonthBudget> | null>(null);
  const [posBudget, setPosBudget] = useState<MonthBudget | null>(null);
  const [evidence, setEvidence] = useState<{ id: number; label: string; kind: 'expense' | 'income'; expectReceipt: boolean } | null>(null);

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
  // "Kein Beleg vorhanden" from the evidence modal: this fixed cost has no invoice →
  // stop expecting one (also flips it to auto-confirmed in months without evidence).
  const expectReceiptOff = useMutation({
    mutationFn: (id: number) => api(`/api/fixed-costs/${id}`, { method: 'PATCH', body: { expect_receipt: false } }),
    onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['fixed-costs'] }); toast(t('finances.evNoReceiptDone'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // Undo "kein Beleg vorhanden": start expecting a receipt again for this fixed cost.
  const expectReceiptOn = useMutation({
    mutationFn: (id: number) => api(`/api/fixed-costs/${id}`, { method: 'PATCH', body: { expect_receipt: true } }),
    onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['fixed-costs'] }); void qc.invalidateQueries({ queryKey: ['fix-evidence'] }); toast(t('finances.evExpectReceiptOn'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // "Nicht mehr aktiv": the plan shows up this month but shouldn't — end it at the
  // last day of the PREVIOUS month (so this month & later drop it, earlier months keep it).
  const priorMonthEnd = () => {
    const [y, mo] = month.split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1, 0)).toISOString().slice(0, 10);
  };
  const endPlan = useMutation({
    mutationFn: (id: number) => api(`/api/fixed-costs/${id}`, { method: 'PATCH', body: { end_date: priorMonthEnd() } }),
    onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['fixed-costs'] }); toast(t('finances.evEndDone'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString(
    i18n.language === 'en' ? 'en-GB' : 'de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const incomes = data?.incomes ?? [];   // recurring income PLANS (Einnahmen-Soll)
  const fixed = data?.fixed ?? [];
  const budgets = data?.budgets ?? [];

  // Deep-link from the Auszüge list (?fx=<id>): open that plan's evidence modal so a
  // statement allocated to a generated one-off income jumps straight to the entry.
  useEffect(() => {
    if (!fx || !data) return;
    const f = [...(data.incomes ?? []), ...(data.fixed ?? [])].find(p => String(p.id) === fx);
    if (f) { setEvidence({ id: f.id, label: f.label, kind: f.kind, expectReceipt: f.expect_receipt }); setFx(''); }
  }, [fx, data, setFx]);
  // Summary mirrors fixed costs: sum the PLANS (Soll), not just the matched actuals.
  // Internal transfers (Umbuchung) net to zero across the household, so they're
  // excluded from the gross totals in the whole-household view; in a single-account
  // scope only one leg is present, so they count (Martin −2000 / Haushalt +2000).
  const counts = (f: MonthFix) => !isAll || !f.is_transfer;
  // Effective amount for the summary: once a match is CONFIRMED, the real value (from
  // the receipt / bank / pay slip) replaces the plan value (e.g. a salary with a bonus,
  // or a month where it was less than planned). Falls back to the plan (Soll) until then.
  const effEur = (f: MonthFix) => amortized(f.check?.status === 'confirmed' && f.check.amount != null ? f.check.amount : f.monthly_eur, f.frequency);
  const incomeTotal = incomes.reduce((s, f) => s + (counts(f) ? effEur(f) : 0), 0);
  const fixTotal = fixed.reduce((s, f) => s + (counts(f) ? effEur(f) : 0), 0);
  // 2×2 for the month lists: FIXED (recurring) vs VARIABLE (single-month one-off) on
  // both the income and the cost side. One-offs are the generated single-month entries.
  const fixedIncome = incomes.filter(f => !f.one_off);
  const varIncome = incomes.filter(f => f.one_off);
  const fixedCosts = fixed.filter(f => !f.one_off);
  const oneOffCosts = fixed.filter(f => f.one_off);
  const fixRow = (f: MonthFix) => (
    <FixCheckRow key={f.id} f={f} month={month} t={t} excluded={isAll && f.is_transfer}
      onConfirmSuggestion={() => confirmSug(f)}
      onClear={() => check.mutate({ fixed_cost_id: f.id, month, action: 'clear' })}
      onShowEvidence={() => setEvidence({ id: f.id, label: f.label, kind: f.kind, expectReceipt: f.expect_receipt })} />
  );
  // Reconciliation completeness: a plan is "complete" when its bank booking is linked
  // AND the receipt question is resolved (attached / pay slip / "kein Beleg") — the
  // backend decides. The month %-bar covers income plans + fixed costs together.
  const fixDone = fixed.filter(f => f.complete).length;
  const incDone = incomes.filter(f => f.complete).length;
  const planTotal = incomes.length + fixed.length;
  const planDone = fixDone + incDone;
  const donePct = planTotal ? Math.round((planDone / planTotal) * 100) : 100;
  const varActual = budgets.reduce((s, b) => s + b.actual, 0);
  const varTarget = budgets.reduce((s, b) => s + b.monthly_target, 0);
  const net = Math.round((incomeTotal - fixTotal - varActual) * 100) / 100;

  // When the evidence amount differs from the plan (a bonus on the salary, a cheaper
  // month …), ask whether to accept the delta; the real value then replaces the plan.
  const okDelta = async (f: MonthFix, actual: number | null | undefined): Promise<boolean> => {
    if (actual == null) return true;
    if (Math.abs(Math.round((actual - f.monthly_eur) * 100) / 100) < 0.01) return true;
    return confirm({
      title: t('finances.deltaTitle'),
      message: t('finances.deltaMsg', { plan: eur(f.monthly_eur), actual: eur(actual) }),
      confirmLabel: t('finances.deltaAccept'), cancelLabel: t('common.cancel'),
    });
  };
  // Confirm the auto-suggestion, passing the id of whichever evidence kind it is.
  const confirmSug = async (f: MonthFix) => {
    if (!(await okDelta(f, f.suggestion?.betrag))) return;
    check.mutate({
      fixed_cost_id: f.id, month, action: 'confirm',
      einkauf_id: f.suggestion!.source === 'receipt' ? f.suggestion!.einkauf_id : null,
      bank_tx_id: f.suggestion!.source === 'bank' ? f.suggestion!.bank_tx_id : null,
      income_id: f.suggestion!.source === 'income' ? f.suggestion!.income_id : null,
    });
  };

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
                <div className={cn('text-xs', fixDone === fixed.length && fixed.length > 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-amber-600 dark:text-amber-500')}>
                  {t('finances.checkedOf', { done: fixDone, total: fixed.length })}
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
            {/* Reconciliation completeness for the month (income plans + fixed costs). */}
            {planTotal > 0 && (
              <div className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-zinc-500 dark:text-zinc-400">{t('finances.allocatedTitle')}</span>
                  <span className={cn('font-semibold', donePct === 100 ? 'text-emerald-600 dark:text-emerald-500' : 'text-amber-600 dark:text-amber-500')}>{donePct}% · {planDone}/{planTotal}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className={cn('h-full rounded-full transition-all', donePct === 100 ? 'bg-emerald-500' : 'bg-amber-500')} style={{ width: `${donePct}%` }} />
                </div>
              </div>
            )}
          </Card>

          {/* 2×2, all collapsed by default: Fixed/Variable income, Fixed/Variable costs */}
          {/* Fixed income — recurring income plans (salary, Kindergeld, Beiträge) */}
          <Section title={t('finances.fixedIncomeTitle')} count={fixedIncome.length} defaultOpen={false}>
            {!fixedIncome.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noIncomePlans')}</Card>}
            {fixedIncome.map(fixRow)}
          </Section>

          {/* Variable income — one-off incomes (generated single-month, e.g. "…Spesen") */}
          <Section title={t('finances.varIncomeTitle')} count={varIncome.length} defaultOpen={false}>
            {!varIncome.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noVarIncome')}</Card>}
            {varIncome.map(fixRow)}
          </Section>

          {/* Fixed costs — recurring expense plans (rent, internet, subscriptions) */}
          <Section title={t('finances.fixTitle')} count={fixedCosts.length} defaultOpen={false}>
            {!fixedCosts.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noFixThisMonth')}</Card>}
            {fixedCosts.map(fixRow)}
          </Section>

          {/* Variable costs — category budgets + one-off (single-month) expenses */}
          <Section title={t('finances.varTitle')} count={budgets.length + oneOffCosts.length} defaultOpen={false}
            right={<Button variant="secondary" className="px-2.5 py-1.5 text-xs" onClick={() => setBudgetModal({})}><Plus size={14} /> {t('finances.addBudget')}</Button>}>
            {oneOffCosts.map(fixRow)}
            {!budgets.length && !oneOffCosts.length && <Card className="p-3 text-xs text-zinc-400">{t('finances.noBudgets')}</Card>}
            {budgets.map(b => <BudgetRow key={b.id} b={b} t={t} onEdit={() => setBudgetModal(b)} onOpen={() => setPosBudget(b)} />)}
          </Section>
        </>
      )}

      {picker && (
        <ReceiptPicker month={month} fix={picker} onClose={() => setPicker(null)}
          onPick={async (ev, amount) => {
            if (!Object.keys(ev).length) return;                       // nothing selected → no-op
            if (!(await okDelta(picker, amount))) return;
            // Close only on success (check.onSuccess → invalidate + setPicker(null));
            // on failure the picker stays open and an error toast shows.
            check.mutate({ fixed_cost_id: picker.id, month, action: 'confirm', ...ev });
          }} />
      )}
      {budgetModal && <BudgetModal initial={budgetModal} onClose={() => setBudgetModal(null)} onSaved={invalidate} />}
      {posBudget && <BudgetPositions budget={posBudget} month={month} onClose={() => setPosBudget(null)} />}
      {evidence && <FixedEvidenceModal id={evidence.id} label={evidence.label} kind={evidence.kind} month={month} t={t}
        expectReceipt={evidence.expectReceipt}
        onClose={() => setEvidence(null)}
        onNoReceipt={() => { expectReceiptOff.mutate(evidence.id); setEvidence(e => e && { ...e, expectReceipt: false }); }}
        onExpectReceiptOn={() => { expectReceiptOn.mutate(evidence.id); setEvidence(e => e && { ...e, expectReceipt: true }); }}
        onFindReceipt={() => {
          const list = evidence.kind === 'income' ? (data?.incomes ?? []) : (data?.fixed ?? []);
          const f = list.find(x => x.id === evidence.id);
          setEvidence(null);
          if (f) setPicker(f);
        }}
        onEndPlan={() => {
          const msg = evidence.kind === 'income' ? t('finances.evEndIncomeConfirm', { label: evidence.label }) : t('finances.evEndFixedConfirm', { label: evidence.label });
          if (!window.confirm(msg)) return;
          endPlan.mutate(evidence.id);
          setEvidence(null);
        }} />}
    </div>
  );
}

interface FixEvidence {
  status: string | null; amount: number | null;
  bank: { id: number; datum: string; amount: number; counterparty: string | null; private: boolean } | null;
  receipt: { id: number | null; laden: string | null; datum: string; betrag: number; quelle: string; private: boolean } | null;
  income: { id: number; datum: string; description: string | null; amount: number; has_file: boolean; file_name: string | null } | null;
}

/** Click a confirmed Fixkosten row → see the full evidence chain: the bank booking
 *  AND the receipt/e-mail (or income), whichever — or both — is attached. Each is a
 *  link (bank → Auszüge search, receipt → its detail page). */
function FixedEvidenceModal({ id, label, kind, month, t, expectReceipt, onClose, onNoReceipt, onExpectReceiptOn, onFindReceipt, onEndPlan }: {
  id: number; label: string; kind: 'expense' | 'income'; month: string; t: (k: string, o?: Record<string, unknown>) => string;
  expectReceipt: boolean; onClose: () => void; onNoReceipt: () => void; onExpectReceiptOn: () => void; onFindReceipt: () => void; onEndPlan: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [viewPayslip, setViewPayslip] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['fix-evidence', id, month],
    queryFn: () => api<FixEvidence>(`/api/finances/fixed-cost/${id}/evidence?month=${month}`),
  });
  // Attach a pay slip to the linked income row (income "receipt"), mirroring the
  // Verwaltung income list — so income evidence has the same proof flow as fixed costs.
  const attach = useMutation({
    mutationFn: async ({ id: incId, file }: { id: number; file: File }) => {
      const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('read failed')); r.readAsDataURL(file); });
      return api(`/api/finances/income/${incId}/file`, { method: 'POST', body: { filename: file.name, data_b64: b64 } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fix-evidence'] }); void qc.invalidateQueries({ queryKey: ['fin-month'] }); void qc.invalidateQueries({ queryKey: ['fin-income'] }); toast(t('finances.income.attached'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // Detach a single evidence leg (bank statement / receipt / income) from this month.
  const unlink = useMutation({
    mutationFn: (leg: 'bank' | 'receipt' | 'income') => api(`/api/finances/fixed-cost/${id}/evidence/unlink`, { method: 'POST', body: { month, leg } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fix-evidence'] }); void qc.invalidateQueries({ queryKey: ['fin-month'] }); toast(t('finances.evUnlinked'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const go = (to: string) => { onClose(); navigate(to); };
  const rowCls = 'flex items-center gap-3 rounded-xl border border-zinc-200 p-3 text-left dark:border-zinc-800';
  return (
    <>
    <Modal open onClose={onClose} title={label}>
      <div className="flex flex-col gap-2.5">
        {isLoading ? <Spinner /> : !data ? <p className="text-xs text-zinc-400">–</p> : (
          <>
            <p className="text-xs text-zinc-400">{t('finances.evidenceIntro')}</p>
            {/* Bank booking — the source of truth. Only a link when there's a
                counterparty to search Auszüge by (else it would land unfiltered). */}
            {data.bank ? (() => { const bankLink = !data.bank.private && !!data.bank.counterparty; return (
              <div className={rowCls}>
                <button type="button" disabled={!bankLink} onClick={() => bankLink && go(`/finanzen?tab=bank&bq=${encodeURIComponent(data.bank!.counterparty!)}&bhl=${data.bank!.id}`)}
                  className={cn('flex min-w-0 flex-1 items-center gap-3 text-left', bankLink && 'hover:opacity-75')}>
                  <Landmark size={18} className="shrink-0 text-sky-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.evidenceBank')}</div>
                    <div className="truncate text-sm">{data.bank.private ? t('finances.privatePurchase') : (data.bank.counterparty || '—')}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold">{eur(data.bank.amount)}</div>
                    <div className="text-[10px] text-zinc-400">{ddmmyyyy(data.bank.datum)}</div>
                  </div>
                  {bankLink && <ChevronRight size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
                </button>
                {!data.bank.private && <button type="button" onClick={() => unlink.mutate('bank')} disabled={unlink.isPending} title={t('finances.evUnlink')}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Link2Off size={15} /></button>}
              </div>); })()
            : (
              // No bank booking this month → either find the statement, or the plan
              // is no longer active (end it at the end of the previous month).
              <div className="rounded-xl border border-dashed border-zinc-200 p-3 dark:border-zinc-800">
                <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400"><Landmark size={14} /> {t('finances.evidenceNoBank')}</div>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={onFindReceipt} className="rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-700">{t('finances.evFindBank')}</button>
                  <button type="button" onClick={onEndPlan} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">{kind === 'income' ? t('finances.evEndIncome') : t('finances.evEndFixed')}</button>
                </div>
              </div>
            )}
            {/* Receipt / e-mail invoice (expense) */}
            {kind === 'expense' && data.receipt && (
              <div className={rowCls}>
                <button type="button" disabled={data.receipt.private || data.receipt.id == null}
                  onClick={() => data.receipt?.id != null && go(`/receipts/${data.receipt.id}`)}
                  className={cn('flex min-w-0 flex-1 items-center gap-3 text-left', !data.receipt.private && data.receipt.id != null && 'hover:opacity-75')}>
                  {data.receipt.private ? <Lock size={18} className="shrink-0 text-zinc-400" /> : <Receipt size={18} className="shrink-0 text-emerald-500" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.evidenceReceipt')}</div>
                    <div className="truncate text-sm">{data.receipt.private ? t('finances.privatePurchase') : (data.receipt.laden || '—')}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold">{eur(data.receipt.betrag)}</div>
                    <div className="text-[10px] text-zinc-400">{ddmmyyyy(data.receipt.datum)}</div>
                  </div>
                  {!data.receipt.private && data.receipt.id != null && <ChevronRight size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
                </button>
                {!data.receipt.private && <button type="button" onClick={() => unlink.mutate('receipt')} disabled={unlink.isPending} title={t('finances.evUnlink')}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Link2Off size={15} /></button>}
              </div>
            )}
            {/* Income row (pay slip) — the proof for an income plan; view / attach here */}
            {kind === 'income' && data.income && (
              <div className={rowCls}>
                <Wallet size={18} className="shrink-0 text-teal-500" />
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.evidenceIncome')}</div>
                  <div className="truncate text-sm">{data.income.description || '—'}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold">{eur(data.income.amount)}</div>
                  <div className="text-[10px] text-zinc-400">{ddmmyyyy(data.income.datum)}</div>
                </div>
                {data.income.has_file ? (
                  <button type="button" onClick={() => setViewPayslip(true)} title={t('finances.income.view')}
                    className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"><FileText size={16} /></button>
                ) : (
                  <label className="shrink-0 cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800" title={t('finances.income.attach')}>
                    <Paperclip size={16} />
                    <input type="file" accept=".pdf,image/*" className="hidden" onChange={e => { const fl = e.target.files?.[0]; const inc = data.income; if (fl && inc) attach.mutate({ id: inc.id, file: fl }); e.currentTarget.value = ''; }} />
                  </label>
                )}
                <button type="button" onClick={() => unlink.mutate('income')} disabled={unlink.isPending} title={t('finances.evUnlink')}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><Link2Off size={15} /></button>
              </div>
            )}
            {/* Proof resolution: find, (income) attach above, or mark "kein Beleg" (undo-able) */}
            {(() => {
              const hasProof = kind === 'expense' ? !!data.receipt : !!(data.income && data.income.has_file);
              if (hasProof) return null;
              if (expectReceipt === false) return (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-zinc-200 p-3 dark:border-zinc-800">
                  <span className="inline-flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400"><CheckCircle2 size={14} className="shrink-0 text-zinc-400" /> {t('finances.evNoReceiptState')}</span>
                  <button type="button" onClick={onExpectReceiptOn} className="shrink-0 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">{t('finances.evExpectReceiptOn')}</button>
                </div>
              );
              const canFind = kind === 'expense' ? !data.receipt : !data.income;
              return (
                <div className="rounded-xl border border-dashed border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400"><Receipt size={14} /> {kind === 'income' ? t('finances.evidenceNoProof') : t('finances.evidenceNoReceipt')}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {canFind && <button type="button" onClick={onFindReceipt} className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700">{kind === 'income' ? t('finances.evFindIncome') : t('finances.evFindReceipt')}</button>}
                    <button type="button" onClick={onNoReceipt} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">{t('finances.evNoReceiptNeeded')}</button>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>
    </Modal>
    {viewPayslip && data?.income && <PayslipViewer id={data.income.id} name={data.income.file_name ?? ''} t={t} onClose={() => setViewPayslip(false)} />}
    </>
  );
}

function FixCheckRow({ f, t, excluded, onConfirmSuggestion, onClear, onShowEvidence }: {
  f: MonthFix; month: string; t: (k: string, o?: Record<string, unknown>) => string; excluded?: boolean;
  onConfirmSuggestion: () => void; onClear: () => void;
  onShowEvidence: () => void;
}) {
  const delta = f.check?.amount != null ? Math.round((f.check.amount - f.monthly_eur) * 100) / 100 : null;
  const periodic = f.frequency && f.frequency !== 'monthly';
  const shownAmount = periodic ? amortized(f.monthly_eur, f.frequency) : f.monthly_eur;
  const skipped = f.check?.status === 'skipped';
  const hasCheck = !!f.check;
  // Reconciliation state (backend decides `complete` = bank linked + receipt resolved):
  //   done      → fully reconciled (green)     skipped → deliberately no evidence (grey)
  //   incomplete→ check exists but a leg is still missing (amber, → Nachweis-Modal)
  //   suggest   → an auto match is offered (amber)   open → nothing yet (grey)
  // Everything except done/skipped stays actionable ("Verknüpfen") — including a
  // no-receipt/transfer plan whose bank booking still needs to be linked.
  const rstate: 'done' | 'skipped' | 'incomplete' | 'suggest' | 'open' =
    skipped ? 'skipped' : f.complete ? 'done' : hasCheck ? 'incomplete' : f.suggestion ? 'suggest' : 'open';
  const actionable = rstate !== 'done' && rstate !== 'skipped';
  const IconEl = rstate === 'done' || rstate === 'skipped' ? CheckCircle2
    : rstate === 'incomplete' ? AlertCircle : rstate === 'suggest' ? CircleDot : Circle;
  return (
    // The whole row is the single entry point → opens the one evidence menu (no
    // separate "link" button). Inner action buttons stopPropagation.
    <Card onClick={onShowEvidence} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShowEvidence(); } }}
      className="flex cursor-pointer flex-col gap-2 p-3 transition hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30">
      <div className="flex items-center gap-2.5">
        <IconEl size={18} className={cn('shrink-0',
          rstate === 'done' && 'text-emerald-500', rstate === 'skipped' && 'text-zinc-400',
          (rstate === 'incomplete' || rstate === 'suggest') && 'text-amber-500',
          rstate === 'open' && 'text-zinc-300 dark:text-zinc-600')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium">{f.label}</span>
            <span className="shrink-0 text-xs text-zinc-400">{scopeLabelOf(t, f)}</span>
            {f.is_transfer && <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{t('finances.transferBadge')}</span>}
            {f.one_off && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{t('finances.oneOffBadge')}</span>}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {rstate === 'skipped' && t('finances.skippedMonth')}
            {hasCheck && !skipped && f.check!.source !== 'none' && (
              <button type="button" onClick={onShowEvidence} className="inline-flex items-center gap-1 text-left hover:text-zinc-700 hover:underline dark:hover:text-zinc-200" title={t('finances.showEvidence')}>
                {f.check!.source === 'bank' ? t('finances.bankShort') : f.check!.source === 'income' ? t('finances.incomeShort') : t('finances.receiptShort')} {f.check!.datum} „{f.check!.laden}“ · {eur(f.check!.amount)}{delta != null && Math.abs(delta) >= 0.01 && <span className={cn('ml-1', delta > 0 ? 'text-amber-600' : 'text-emerald-600')}>Δ {delta > 0 ? '+' : ''}{eur(delta)}</span>}
                <ChevronRight size={12} className="shrink-0 text-zinc-400" />
              </button>)}
            {rstate === 'suggest' && f.suggestion && (
              <>{t('finances.suggestion')} „{f.suggestion.laden}“ {eur(f.suggestion.betrag)} · {f.suggestion.datum.slice(8, 10)}.{f.suggestion.datum.slice(5, 7)}.{f.suggestion.source === 'bank' && <Badge className="ml-1.5">{t('finances.bankBadge')}</Badge>}</>
            )}
            {rstate === 'open' && (f.expect_receipt === false || f.is_transfer ? t('finances.noReceiptBankOpen') : f.kind === 'income' ? t('finances.noIncomeFound') : t('finances.noReceiptFound'))}
            {/* Amber to-do chip names the leg that's actually missing: the bank booking
                (the usual case) or, once that's linked, the receipt/proof. */}
            {rstate === 'incomplete' && <button type="button" onClick={onShowEvidence} className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300">{t(!f.bank_linked ? 'finances.bankOpen' : f.kind === 'income' ? 'finances.proofOpen' : 'finances.receiptOpen')}</button>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn('text-sm font-semibold', excluded && 'text-zinc-400 line-through')}>{eur(shownAmount)}</div>
          {periodic && <div className="text-[10px] text-zinc-400">{eur(f.monthly_eur)} {t(`finances.freqPer.${f.frequency}`)}</div>}
          {excluded && <div className="text-[10px] text-violet-500">{t('finances.notCounted')}</div>}
        </div>
      </div>
      {actionable && (
        <div className="flex flex-wrap gap-1.5 pl-7" onClick={e => e.stopPropagation()}>
          {rstate === 'suggest' && <Button className="px-2.5 py-1 text-xs" onClick={onConfirmSuggestion}>{t('finances.confirm')}</Button>}
          {hasCheck && <Button variant="ghost" className="px-2.5 py-1 text-xs" onClick={onClear}>{t('finances.reopen')}</Button>}
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
  month: string; fix: MonthFix; onClose: () => void; onPick: (ev: PickEv, amount: number | null) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const isIncome = fix.kind === 'income';
  // Two independent selections: a DOCUMENT (invoice / pay slip) and the bank STATEMENT
  // (the actual payment). Pick one from each — or just one — then "Verknüpfen" links
  // both onto the same check, so the row is fully reconciled (Beleg + Bankbuchung).
  // Pre-seed from the existing check so adding one leg never wipes the other (confirm
  // rebuilds the check from the passed ids).
  const [docSel, setDocSel] = useState<{ id: number; amount: number | null } | null>(() => {
    const c = fix.check;
    if (c?.einkauf_id != null) return { id: c.einkauf_id, amount: c.amount };
    if (c?.income_id != null) return { id: c.income_id, amount: c.amount };
    // The check has no document leg → pre-select the deterministic suggestion's doc so
    // the likely match is already green and one "Verknüpfen" confirms it. A PARTIAL
    // check (e.g. income plan with a pay slip but no bank) still gets a suggestion for
    // its missing leg (see the /month isComplete guard), so its bank is pre-picked below.
    const s = fix.suggestion;
    if (s?.source === 'receipt' && s.einkauf_id != null) return { id: s.einkauf_id, amount: s.betrag };
    if (s?.source === 'income' && s.income_id != null) return { id: s.income_id, amount: s.betrag };
    return null;
  });
  const [bankSel, setBankSel] = useState<{ id: number; amount: number | null } | null>(() => {
    const c = fix.check;
    if (c?.bank_tx_id != null) return { id: c.bank_tx_id, amount: c.amount };
    // The check has no bank leg → pre-select the suggested bank statement (green), so an
    // income plan holding only its pay slip gets its Gutschrift pre-picked for 1-click.
    const s = fix.suggestion;
    if (s?.source === 'bank' && s.bank_tx_id != null) return { id: s.bank_tx_id, amount: s.betrag };
    return null;
  });

  // Both kinds return {items:[{source,id,datum,amount,label}]}: income → pay-slip rows
  // + bank credits; expense → invoices + bank debits (wide window for booking lag).
  const evidenceQ = useQuery({
    queryKey: ['fin-picker', fix.kind, month],
    queryFn: () => api<{ items: { source: 'income' | 'bank' | 'receipt'; id: number; datum: string; amount: number; label: string }[] }>(
      isIncome ? `/api/finances/income-evidence?month=${month}` : `/api/finances/expense-evidence?month=${month}`),
  });
  const isLoading = evidenceQ.isLoading;

  const items = evidenceQ.data?.items ?? [];
  const hit = (l: string) => !q.trim() || l.toLowerCase().includes(q.trim().toLowerCase());
  const docs = items.filter(i => i.source !== 'bank' && hit(i.label));   // invoices / pay-slip rows
  const banks = items.filter(i => i.source === 'bank' && hit(i.label));  // bank statement lines
  const canLink = !!docSel || !!bankSel;
  const doLink = () => {
    const ev: PickEv = {};
    if (docSel) { if (isIncome) ev.income_id = docSel.id; else ev.einkauf_id = docSel.id; }
    if (bankSel) ev.bank_tx_id = bankSel.id;
    onPick(ev, docSel?.amount ?? bankSel?.amount ?? null);
  };
  const evRow = (i: { source: string; id: number; datum: string; amount: number; label: string }, selected: boolean, onClick: () => void) => (
    <button key={`${i.source}:${i.id}`} type="button" onClick={onClick}
      className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition',
        selected ? 'border-emerald-500 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-950/30'
          : 'border-zinc-200 hover:border-emerald-400 hover:bg-emerald-50/50 dark:border-zinc-800 dark:hover:bg-emerald-950/20')}>
      <span className="w-12 shrink-0 text-xs text-zinc-400">{i.datum?.slice(8, 10)}.{i.datum?.slice(5, 7)}.</span>
      <span className="min-w-0 flex-1 truncate text-sm">{i.label}</span>
      <span className="shrink-0 text-sm font-medium">{i.amount != null ? eur(i.amount) : '–'}</span>
      {selected ? <CheckCircle2 size={16} className="shrink-0 text-emerald-500" /> : <Circle size={16} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
    </button>
  );

  return (
    <Modal open onClose={onClose} title={`${t(isIncome ? 'finances.incomePickerTitle' : 'finances.pickerTitle')} · ${fix.label}`}>
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-8" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={t('finances.pickerSearch')} />
        </div>
        {isLoading ? <Spinner /> : (
          <div className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto">
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t(isIncome ? 'finances.pickIncomeDoc' : 'finances.pickInvoice')}</div>
              {docs.length ? docs.map(i => evRow(i, docSel?.id === i.id, () => setDocSel(s => s?.id === i.id ? null : { id: i.id, amount: i.amount })))
                : <p className="px-1 py-1 text-xs text-zinc-400">{t(isIncome ? 'finances.incomePickerEmpty' : 'finances.pickerEmpty')}</p>}
            </div>
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.pickStatement')}</div>
              {banks.length ? banks.map(i => evRow(i, bankSel?.id === i.id, () => setBankSel(s => s?.id === i.id ? null : { id: i.id, amount: i.amount })))
                : <p className="px-1 py-1 text-xs text-zinc-400">{t('finances.pickNoStatements')}</p>}
            </div>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 pt-2.5 dark:border-zinc-800">
          <Button variant="ghost" className="px-3 py-1.5 text-xs" onClick={onClose}>{t('common.cancel')}</Button>
          <Button className="px-3 py-1.5 text-xs" disabled={!canLink} onClick={doLink}><Link2 size={14} className="mr-1 inline" />{t('finances.linkSelected')}</Button>
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

/** Umbuchung pairing control: link this transfer leg to its opposite leg — pick
 *  an existing fixed cost or create the counterpart on another account. Only
 *  shown for a saved transfer; a brand-new row must be saved before it can pair
 *  (the backend needs its id to write the symmetric link). */
function CounterpartField({ draft, setDraft, costs, scopeKonten }: {
  draft: Draft; setDraft: (d: Draft) => void; costs: FixedCost[]; scopeKonten: KontoLite[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [cpLabel, setCpLabel] = useState('');
  const [cpKonto, setCpKonto] = useState('');

  const partner = draft.counterpart_id != null ? costs.find(c => c.id === draft.counterpart_id) : null;
  // The natural counterpart is an opposite-kind transfer on *another* account.
  const candidates = costs.filter(c => c.is_transfer && c.id !== draft.id && c.kind !== draft.kind && String(c.konto_id) !== draft.konto_id);

  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/api/fixed-costs', { method: 'POST', body: {
      label: cpLabel.trim(),
      monthly_eur: draft.monthly_eur,
      kind: draft.kind === 'income' ? 'expense' : 'income',
      frequency: draft.frequency,
      is_transfer: true,
      konto_id: Number(cpKonto),
      category_path: draft.category_path,
      start_date: draft.start_date,
      end_date: draft.end_date || null,
      active: draft.active,
      expect_receipt: false,
      counterpart_id: draft.id,
    } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['fixed-costs'] });
      setDraft({ ...draft, counterpart_id: r.id });
      setCreating(false); setCpLabel(''); setCpKonto('');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // Matching bank bookings on another account (opposite sign, same amount) that can
  // BE the counterpart — picking one auto-creates its Fixkosten leg + links + pairs.
  const { data: bankCands } = useQuery({
    queryKey: ['cp-bank', draft.id],
    queryFn: () => api<{ candidates: { id: number; konto_id: number; konto_name: string | null; datum: string; amount: number; counterparty: string | null }[] }>(`/api/finances/fixed-cost/${draft.id}/bank-counterpart-candidates`),
    enabled: !!draft.id,
  });
  const pairFromBank = useMutation({
    mutationFn: (bankTxId: number) => api<{ counterpart_id: number }>(`/api/finances/fixed-cost/${draft.id}/counterpart-from-bank`, { method: 'POST', body: { bank_tx_id: bankTxId } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['fixed-costs'] });
      void qc.invalidateQueries({ queryKey: ['bank-tx'] });
      void qc.invalidateQueries({ queryKey: ['fin-month'] });
      setDraft({ ...draft, counterpart_id: r.counterpart_id });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (!draft.id) return <p className="pl-11 text-xs text-zinc-400">{t('finances.cpSaveFirst')}</p>;

  return (
    <div className="ml-11 rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900/50 dark:bg-violet-950/20">
      <Label>{t('finances.counterpart')}</Label>
      {partner ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="min-w-0 truncate">↔ <span className="font-medium">{partner.label}</span> <span className="text-zinc-500">· {partner.konto_name}</span></span>
          <button type="button" onClick={() => setDraft({ ...draft, counterpart_id: null })}
            className="shrink-0 text-xs text-red-500 hover:underline">{t('finances.unlink')}</button>
        </div>
      ) : creating ? (
        <div className="flex flex-col gap-2">
          <Input value={cpLabel} onChange={e => setCpLabel(e.target.value)} placeholder={t('finances.label')} />
          <Select value={cpKonto} onChange={e => setCpKonto(e.target.value)}>
            <option value="" disabled>–</option>
            {scopeKonten.filter(k => String(k.id) !== draft.konto_id).map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
          </Select>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setCreating(false); setCpLabel(''); setCpKonto(''); }}
              className="text-xs text-zinc-500 hover:underline">{t('common.cancel')}</button>
            <button type="button" disabled={!cpLabel.trim() || !cpKonto || create.isPending} onClick={() => create.mutate()}
              className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50">{t('finances.cpCreate')}</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Select value="" onChange={e => e.target.value && setDraft({ ...draft, counterpart_id: Number(e.target.value) })}>
            <option value="">{t('finances.cpPick')}</option>
            {candidates.map(c => <option key={c.id} value={c.id}>{c.label} · {c.konto_name}</option>)}
          </Select>
          {(bankCands?.candidates.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.cpBankCandidates')}</div>
              {bankCands!.candidates.map(b => (
                <button key={b.id} type="button" disabled={pairFromBank.isPending} onClick={() => pairFromBank.mutate(b.id)}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2 py-1.5 text-left text-xs hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50">
                  <Landmark size={12} className="shrink-0 text-sky-500" />
                  <span className="min-w-0 flex-1 truncate">{b.counterparty || '—'} <span className="text-zinc-400">· {b.konto_name}</span></span>
                  <span className="shrink-0 tabular-nums">{eur(b.amount)}</span>
                  <span className="shrink-0 text-zinc-400">{ddmmyyyy(b.datum)}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => { setCreating(true); setCpLabel(draft.label); }}
            className="self-start text-xs text-violet-600 hover:underline dark:text-violet-400">+ {t('finances.cpCreate')}</button>
        </div>
      )}
      <p className="mt-2 text-xs text-zinc-400">{t('finances.counterpartHint')}</p>
    </div>
  );
}

type Draft = { id?: number; label: string; monthly_eur: string; kind: 'expense' | 'income'; frequency: Freq; is_transfer: boolean; konto_id: string; category_path: string | null; start_date: string; end_date: string; active: boolean; expect_receipt: boolean; match_merchant: string; counterpart_id: number | null };
const emptyDraft = (kontoId?: number, kind: 'expense' | 'income' = 'expense'): Draft => ({
  label: '', monthly_eur: '', kind, frequency: 'monthly', is_transfer: false, konto_id: kontoId ? String(kontoId) : '', category_path: null,
  start_date: today(), end_date: '', active: true, expect_receipt: true, match_merchant: '', counterpart_id: null,
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
  has_file?: boolean; file_name?: string | null;
  bank: { id: number; booking_date: string; amount: number; counterparty: string | null } | null;
}

/** View a stored pay-slip file. Fetched with the auth header (the file endpoint is
 *  auth-guarded, so a plain <img>/<iframe> src wouldn't carry the token) into a blob
 *  object URL, shown inline; PDFs in an iframe, images as <img>. */
function PayslipViewer({ id, name, t, onClose }: {
  id: number; name: string; t: (k: string, o?: Record<string, unknown>) => string; onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [isPdf, setIsPdf] = useState(true);
  const [err, setErr] = useState(false);
  // Mobile browsers (esp. iOS Safari) render a PDF inside an <iframe> as a blank box.
  // On touch/coarse-pointer devices offer open/download instead of the dead preview.
  const [coarse] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const token = getToken();
        const res = await fetch(`/api/finances/income/${id}/file`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) { setUrl(objectUrl); setIsPdf(blob.type === 'application/pdf'); }
      } catch { if (!cancelled) setErr(true); }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return (
    <Modal open onClose={onClose} title={name || t('finances.income.viewPayslip')} wide>
      <div className="flex flex-col gap-2">
        {err ? <p className="py-10 text-center text-sm text-zinc-400">{t('finances.income.viewError')}</p>
          : !url ? <div className="flex justify-center py-16"><Spinner /></div>
            : !isPdf ? <img src={url} alt={name} className="mx-auto max-h-[72vh] rounded-lg" />
              : coarse ? (
                // Touch device: an embedded PDF stays blank, so present it as actions.
                <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
                  <FileText size={44} className="text-emerald-500" />
                  <div className="text-sm font-medium">{name || t('finances.income.viewPayslip')}</div>
                  <div className="flex flex-wrap justify-center gap-2">
                    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700">
                      <ExternalLink size={15} /> {t('finances.income.openPdf')}
                    </a>
                    <a href={url} download={name || 'gehaltszettel.pdf'} className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                      <FileText size={15} /> {t('finances.income.downloadPdf')}
                    </a>
                  </div>
                </div>
              )
                : <iframe src={url} title={name} className="h-[72vh] w-full rounded-lg border border-zinc-200 dark:border-zinc-800" />}
        {url && !coarse && <a href={url} target="_blank" rel="noreferrer" className="self-end text-xs text-emerald-600 hover:underline dark:text-emerald-400">{t('finances.income.openTab')}</a>}
      </div>
    </Modal>
  );
}

function IncomeList() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [viewFile, setViewFile] = useState<{ id: number; name: string } | null>(null);
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
  const attach = useMutation({
    mutationFn: async ({ id, file }: { id: number; file: File }) => {
      const b64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('read failed')); r.readAsDataURL(file); });
      return api(`/api/finances/income/${id}/file`, { method: 'POST', body: { filename: file.name, data_b64: b64 } });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fin-income'] }); toast(t('finances.income.attached'), 'success'); },
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
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{ddmmyyyy(r.datum)}</span>
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">{srcLabel(r.source)}</span>
                  {r.konto_id && <span className="truncate">{scopeLabelOf(t, r)}</span>}
                  {r.bank && (
                    <Link to={`/finanzen?tab=bank&bm=${r.bank.booking_date.slice(0, 7)}&bhl=${r.bank.id}`} onClick={e => e.stopPropagation()}
                      className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] text-teal-700 hover:bg-teal-200 dark:bg-teal-900/40 dark:text-teal-300">
                      <Landmark size={10} /> {t('finances.bank.matched')}
                    </Link>
                  )}
                </div>
              </div>
              <span className="shrink-0 text-sm font-semibold text-emerald-600 dark:text-emerald-500">+{eur(r.amount)}</span>
              {r.has_file ? (
                <button
                  onClick={() => setViewFile({ id: r.id, name: r.file_name ?? '' })}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"
                  title={t('finances.income.view')}
                >
                  <FileText size={15} />
                </button>
              ) : (
                <label className="shrink-0 cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800" title={t('finances.income.attach')}>
                  <Paperclip size={15} />
                  <input type="file" accept=".pdf,image/*" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) attach.mutate({ id: r.id, file: f }); e.target.value = ''; }} />
                </label>
              )}
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
      {viewFile && <PayslipViewer id={viewFile.id} name={viewFile.name} t={t} onClose={() => setViewFile(null)} />}
    </Card>
  );
}

// ── Kontobewegungen (bank CSV import + matched-status list) ──────────────────
interface BankTx {
  id: number; konto_id: number | null; konto_name: string | null;
  booking_date: string; purchase_date: string | null; amount: number;
  counterparty: string | null; description: string | null; private: boolean;
  review_flag: boolean;
  status: 'open' | 'fixed' | 'receipt' | 'income';
  receipt: { id: number | null; laden: string | null; betrag: number | null; private: boolean } | null;
  income: { id: number; description: string | null; betrag: number } | null;
  fixed: { id: number; label: string; kind: 'expense' | 'income'; expect_receipt: boolean; month: string } | null;
  suggestion: { kind: 'receipt' | 'income' | 'fixed'; target_id: number; label: string | null; confidence: number; reason: string | null; private: boolean } | null;
}

/** Upload one or more comdirect "Umsätze Girokonto" CSVs into a chosen account.
 *  One CSV = one account (picked here). Re-import is idempotent (dedup by Ref.). */
function BankUpload({ scopeKonten }: { scopeKonten: KontoLite[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [kontoId, setKontoId] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ name: string; ok: boolean; text: string }[]>([]);
  const eff = kontoId || String(scopeKonten[0]?.id ?? '');
  const readB64 = (file: File) => new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('read failed'));
    r.readAsDataURL(file);
  });
  async function onFiles(list: FileList | null) {
    if (!list?.length) return;
    if (!eff) { toast(t('finances.bank.pickAccount'), 'error'); return; }
    setBusy(true);
    const out: { name: string; ok: boolean; text: string }[] = [];
    for (const file of Array.from(list)) {
      try {
        const b64 = await readB64(file);
        const r = await api<{ ok: boolean; imported?: number; skipped?: number; reason?: string }>(
          '/api/finances/bank/upload', { method: 'POST', body: { filename: file.name, data_b64: b64, konto_id: Number(eff) } });
        out.push(r.ok
          ? { name: file.name, ok: true, text: t('finances.bank.importedResult', { imported: r.imported, skipped: r.skipped }) }
          : { name: file.name, ok: false, text: r.reason ?? t('finances.bank.unreadable') });
      } catch (e) { out.push({ name: file.name, ok: false, text: (e as Error).message }); }
      setResults([...out]);
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ['bank-tx'] });
    void qc.invalidateQueries({ queryKey: ['bank-batches'] });
    void qc.invalidateQueries({ queryKey: ['fin-month'] });
    const n = out.filter(o => o.ok).length;
    if (n) toast(t('finances.bank.importedToast', { n }), 'success');
  }
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Upload size={16} className="text-emerald-600 dark:text-emerald-500" />
        <h2 className="text-base font-semibold">{t('finances.bank.heading')}</h2>
      </div>
      <p className="text-xs text-zinc-500">{t('finances.bank.intro')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[9rem] flex-1">
          <Label>{t('finances.bank.account')}</Label>
          <Select value={eff} onChange={e => setKontoId(e.target.value)}>
            {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
          </Select>
        </div>
        <label className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700', busy && 'pointer-events-none opacity-50')}>
          <Upload size={15} />
          {busy ? t('finances.bank.working') : t('finances.bank.choose')}
          <input type="file" accept=".csv,text/csv,text/plain" multiple className="hidden" disabled={busy}
            onChange={e => { void onFiles(e.target.files); e.target.value = ''; }} />
        </label>
      </div>
      {results.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          {results.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              {r.ok ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" /> : <X size={14} className="mt-0.5 shrink-0 text-red-500" />}
              <span className="min-w-0 flex-1"><span className="text-zinc-400">{r.name}</span> — {r.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-zinc-400">{t('finances.bank.hint')}</p>
    </Card>
  );
}

function BankRow({ tx, t, highlight, onOpen, onOpenFixed, onLink, onUnlink, onFlag, onGenerate, onApprove, onDismiss }: {
  tx: BankTx; t: (k: string, o?: Record<string, unknown>) => string; highlight?: boolean;
  onOpen: (receiptId: number) => void; onOpenFixed: (tx: BankTx) => void; onLink: (tx: BankTx) => void; onUnlink: (id: number) => void;
  onFlag: (id: number, flag: boolean) => void; onGenerate: (tx: BankTx) => void;
  onApprove: (id: number) => void; onDismiss: (id: number) => void;
}) {
  useEffect(() => { if (highlight) document.getElementById(`bank-row-${tx.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [highlight, tx.id]);
  const credit = tx.amount > 0;
  const canOpen = tx.status === 'receipt' && tx.receipt?.id != null && !tx.receipt.private;
  // A booking used as evidence for a fixed cost / one-off income (e.g. a generated
  // "…Spesen" income) → jump to that plan's month so the user reaches the generated entry.
  const canOpenFixed = tx.status === 'fixed' && tx.fixed != null;
  const canLink = tx.status === 'open'; // debit → receipt, credit → income row
  const isLinked = tx.status === 'receipt' || tx.status === 'income';
  const badge = tx.status === 'receipt' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
    : tx.status === 'income' ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300'
      : tx.status === 'fixed' ? 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300'
        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
  const onClick = canOpen ? () => onOpen(tx.receipt!.id!) : canOpenFixed ? () => onOpenFixed(tx) : canLink ? () => onLink(tx) : undefined;
  // Long-press (touch or mouse-hold, ~500 ms) toggles the shared red review mark.
  // A fired long-press suppresses the click that follows it.
  const longPressed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPress = () => {
    longPressed.current = false;
    timer.current = setTimeout(() => { longPressed.current = true; onFlag(tx.id, !tx.review_flag); }, 500);
  };
  const cancelPress = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const handleClick = () => { if (longPressed.current) { longPressed.current = false; return; } onClick?.(); };
  useEffect(() => cancelPress, []); // clear a pending long-press timer if the row unmounts mid-hold
  // Inner action buttons swallow the pointer so a hold on them never arms the long-press.
  const stopArm = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <Card
      id={`bank-row-${tx.id}`}
      onClick={handleClick}
      onPointerDown={startPress} onPointerUp={cancelPress} onPointerLeave={cancelPress} onPointerCancel={cancelPress}
      className={cn('flex select-none items-center gap-3 p-3',
        tx.review_flag && 'ring-2 ring-red-400 dark:ring-red-500/70',
        highlight && 'bg-amber-100 ring-2 ring-amber-400 dark:bg-amber-900/30 dark:ring-amber-500/70')}
    >
      {tx.review_flag && <Flag size={14} className="shrink-0 fill-red-500 text-red-500" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {tx.private
            ? <span className="inline-flex items-center gap-1 italic text-zinc-500 dark:text-zinc-400"><Lock size={12} />{t('finances.privatePurchase')}</span>
            : (tx.counterparty || '—')}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{ddmmyyyy(tx.booking_date)}</span>
          {tx.konto_name && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{tx.konto_name}</span>}
          <span className={cn('rounded-full px-1.5 py-0.5 text-[10px]', badge)}>{t(`finances.bank.status_${tx.status}`)}</span>
          {tx.status === 'receipt' && tx.receipt && !tx.receipt.private && tx.receipt.laden && <span className="truncate">→ {tx.receipt.laden}</span>}
          {tx.status === 'income' && tx.income && <span className="truncate">→ {tx.income.description || t('finances.income.entryFallback')}</span>}
          {tx.status === 'fixed' && tx.fixed && <span className="truncate">→ {tx.fixed.label}</span>}
          {canLink && !tx.suggestion && <span className="text-zinc-400">{credit ? t('finances.bank.tapToLinkIncome') : t('finances.bank.tapToLink')}</span>}
          {tx.suggestion && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" title={tx.suggestion.reason ?? undefined}>
              <Sparkles size={11} className="shrink-0 text-amber-500" /> {t('finances.bank.aiSuggests')} <span className="max-w-[10rem] truncate">{tx.suggestion.private ? t('finances.privatePurchase') : (tx.suggestion.label || '—')}</span> · {Math.round(tx.suggestion.confidence * 100)}%
            </span>
          )}
        </div>
      </div>
      <span className={cn('shrink-0 text-sm font-semibold', credit && 'text-emerald-600 dark:text-emerald-500')}>{credit ? '+' : ''}{eur(tx.amount)}</span>
      {tx.suggestion ? (
        <>
          <button onClick={e => { e.stopPropagation(); onApprove(tx.id); }} onPointerDown={stopArm} title={t('finances.bank.approveSuggestion')}
            className="shrink-0 rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"><CheckCircle2 size={16} /></button>
          <button onClick={e => { e.stopPropagation(); onDismiss(tx.id); }} onPointerDown={stopArm} title={t('finances.bank.dismissSuggestion')}
            className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"><X size={16} /></button>
        </>
      ) : (
        <>
          {isLinked && !tx.receipt?.private && (
            <button onClick={e => { e.stopPropagation(); onUnlink(tx.id); }} onPointerDown={stopArm} title={t('finances.bank.unlink')}
              className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-red-500 dark:hover:bg-zinc-800"><Link2Off size={15} /></button>
          )}
          {canLink && (
            <button onClick={e => { e.stopPropagation(); onGenerate(tx); }} onPointerDown={stopArm} title={t('finances.bank.gen.button')}
              className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30"><FilePlus2 size={15} /></button>
          )}
          {canLink && <Link2 size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
          {canOpen && <ChevronRight size={15} className="shrink-0 text-zinc-300 dark:text-zinc-600" />}
        </>
      )}
    </Card>
  );
}

/** Pick a receipt (debit) or income row (credit) to link to a bank transaction.
 *  Candidates come pre-filtered by amount + date window from the backend. */
function BankLinkPicker({ tx, t, onClose, onPick, onApprove }: {
  tx: BankTx; t: (k: string, o?: Record<string, unknown>) => string; onClose: () => void; onPick: (id: number) => void; onApprove: (id: number) => void;
}) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['bank-candidates', tx.id],
    queryFn: () => api<{ kind: 'receipt' | 'income'; candidates: { id: number; label: string | null; betrag: number; datum: string }[] }>(`/api/finances/bank/${tx.id}/candidates`),
  });
  const cands = data?.candidates ?? [];
  const sug = tx.suggestion;
  // Free-text search across ALL still-unlinked receipts (merchant / item / amount /
  // date), so the user can allocate one they know is right even when it falls outside
  // the automatic amount+date window (e.g. an Amazon part-shipment).
  const [q, setQ] = useState('');
  const searching = q.trim().length >= 1;
  const searchQ = useQuery({
    queryKey: ['bank-search', tx.id, q.trim()],
    queryFn: () => api<{ kind: 'receipt' | 'income'; results: { id: number; label: string | null; betrag: number; datum: string }[] }>(`/api/finances/bank/${tx.id}/search-receipts?q=${encodeURIComponent(q.trim())}`),
    enabled: searching,
  });
  const results = searchQ.data?.results ?? [];
  // Debit → receipt candidates: offer a "view" (new tab) so the user can inspect the
  // receipt before linking (e.g. tell apart several Amazon orders found by item name).
  const isDebit = tx.amount < 0;
  // Full CSV booking text (Auftraggeber / Buchungstext / order number / Ref.) so the
  // user can judge what an unclear booking is actually about before allocating it.
  const [showText, setShowText] = useState(false);
  const row = (c: { id: number; label: string | null; betrag: number; datum: string }) => (
    <li key={c.id} className="flex items-center gap-1">
      <button onClick={() => onPick(c.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{c.label || '–'}</div>
          <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{ddmmyyyy(c.datum)}</div>
        </div>
        <span className="shrink-0 text-sm font-semibold">{eur(c.betrag)}</span>
      </button>
      {isDebit && (
        <a href={`/receipts/${c.id}`} target="_blank" rel="noreferrer" title={t('finances.bank.viewReceipt')}
          className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600 dark:hover:bg-zinc-800"><ExternalLink size={15} /></a>
      )}
    </li>
  );
  return (
    <Modal open onClose={onClose} title={tx.amount > 0 ? t('finances.bank.linkIncomeTitle') : t('finances.bank.linkTitle')}>
      <div className="flex flex-col gap-3">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{tx.counterparty} · {eur(tx.amount)} · {ddmmyyyy(tx.booking_date)}</div>
        {/* Full CSV booking text — reveal to judge what an unclear booking is about. */}
        {!tx.private && tx.description && (
          <div>
            <button type="button" onClick={() => setShowText(v => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400">
              <FileText size={13} /> {showText ? t('finances.bank.hideText') : t('finances.bank.showText')}
            </button>
            {showText && <div className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-2 text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">{tx.description}</div>}
          </div>
        )}
        {/* The AI proposal (⭐), distinct from the deterministic matches. Full reason
            shown (not truncated); jump to inspect the proposed receipt, then approve. */}
        {sug && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
            <div className="flex items-start gap-2">
              <Sparkles size={16} className="mt-0.5 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{sug.private ? t('finances.privatePurchase') : (sug.label || '—')}</div>
                <div className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">{t('finances.bank.aiSuggests')} {Math.round(sug.confidence * 100)}%</div>
                {sug.reason && !sug.private && <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{sug.reason}</div>}
              </div>
            </div>
            <div className="mt-2 flex items-center justify-end gap-3">
              {sug.kind === 'receipt' && sug.target_id != null && !sug.private && (
                <button type="button" onClick={() => { onClose(); navigate(`/receipts/${sug.target_id}`); }}
                  className="inline-flex items-center gap-0.5 text-xs font-medium text-amber-700 hover:underline dark:text-amber-300">
                  {t('finances.bank.viewProposed')} <ChevronRight size={13} />
                </button>
              )}
              <button type="button" onClick={() => { onApprove(tx.id); onClose(); }}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700">
                <CheckCircle2 size={14} /> {t('finances.bank.approveSuggestion')}
              </button>
            </div>
          </div>
        )}
        {/* Manual search: allocate any unlinked receipt/income the user knows is right. */}
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <Input className="pl-9 pr-9" placeholder={t(tx.amount > 0 ? 'finances.bank.searchIncomePlaceholder' : 'finances.bank.searchReceiptPlaceholder')} value={q} onChange={e => setQ(e.target.value)} />
          {q && (
            <button onClick={() => setQ('')} title={t('common.clear')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
              <X size={15} />
            </button>
          )}
        </div>
        {searching ? (
          searchQ.isLoading ? <Spinner /> : !results.length ? (
            <p className="py-4 text-center text-xs text-zinc-400">{t('finances.bank.noSearchResults')}</p>
          ) : (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.bank.searchResults')}</div>
              <ul className="-mx-1 flex max-h-[55vh] flex-col divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">{results.map(row)}</ul>
            </>
          )
        ) : isLoading ? <Spinner /> : !cands.length ? (
          !sug && <p className="py-4 text-center text-xs text-zinc-400">{t('finances.bank.noCandidatesHint')}</p>
        ) : (
          <>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t(sug ? 'finances.bank.otherCandidates' : 'finances.bank.suggestedMatches')}</div>
            <ul className="-mx-1 flex max-h-[55vh] flex-col divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">{cands.map(row)}</ul>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Give an open bank line a home when no scan exists: generate a stand-in receipt
 *  (forgotten purchase) or a fixed-cost entry (one-off transfer/top-up). */
function BankGenerateModal({ tx, t, onClose, onDone }: {
  tx: BankTx; t: (k: string, o?: Record<string, unknown>) => string; onClose: () => void; onDone: () => void;
}) {
  const navigate = useNavigate();
  const credit = tx.amount > 0;
  const debit = tx.amount < 0; // only true outflows can become a purchase receipt
  const [mode, setMode] = useState<'einkauf' | 'fixed'>(debit ? 'einkauf' : 'fixed');
  const [laden, setLaden] = useState(tx.counterparty ?? '');
  const [label, setLabel] = useState(tx.counterparty ?? '');
  const [kind, setKind] = useState<'expense' | 'income'>(credit ? 'income' : 'expense');
  // A homed CREDIT is almost always an internal top-up/transfer → default the
  // Umbuchung guard ON so it doesn't inflate the month's income total.
  const [isTransfer, setIsTransfer] = useState(credit);
  const [oneMonth, setOneMonth] = useState(true);

  const genReceipt = useMutation({
    mutationFn: () => api<{ ok: boolean; einkauf_id: number }>(`/api/finances/bank/${tx.id}/generate-receipt`, { method: 'POST', body: { laden: laden.trim() } }),
    // Jump straight into the freshly generated receipt so the user can review/fix it
    // (rename, correct the Konto, add real items) instead of hunting for it in Belege.
    onSuccess: (r) => { toast(t('finances.bank.gen.createdReceipt'), 'success'); onDone(); if (r?.einkauf_id) navigate(`/receipts/${r.einkauf_id}`); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const genFixed = useMutation({
    mutationFn: () => api(`/api/finances/bank/${tx.id}/generate-fixed`, { method: 'POST', body: { label: label.trim(), kind, is_transfer: isTransfer, one_month: oneMonth } }),
    onSuccess: () => { toast(t('finances.bank.gen.createdFixed'), 'success'); onDone(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const busy = genReceipt.isPending || genFixed.isPending;

  return (
    <Modal open onClose={onClose} title={t('finances.bank.gen.title')}>
      <div className="flex flex-col gap-3">
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{tx.counterparty || '—'} · {eur(tx.amount)} · {ddmmyyyy(tx.booking_date)}</div>
        <div className="flex gap-1.5">
          {(debit ? (['einkauf', 'fixed'] as const) : (['fixed'] as const)).map(m => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={cn('flex-1 rounded-xl border px-3 py-2 text-sm font-medium',
                mode === m ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>
              {t(`finances.bank.gen.${m}`)}
            </button>
          ))}
        </div>
        {mode === 'einkauf' ? (
          <>
            <div>
              <Label>{t('finances.bank.gen.laden')}</Label>
              <Input value={laden} onChange={e => setLaden(e.target.value)} placeholder={tx.counterparty ?? ''} />
            </div>
            <p className="text-xs text-zinc-400">{t('finances.bank.gen.receiptHint', { v: eur(Math.abs(tx.amount)) })}</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
              <Button onClick={() => genReceipt.mutate()} disabled={busy}>{t('finances.bank.gen.createReceipt')}</Button>
            </div>
          </>
        ) : (
          <>
            <div>
              <Label>{t('finances.label')}</Label>
              <Input value={label} onChange={e => setLabel(e.target.value)} placeholder={tx.counterparty ?? ''} />
            </div>
            <div className="flex gap-1.5">
              {(['expense', 'income'] as const).map(k => (
                <button key={k} type="button" onClick={() => setKind(k)}
                  className={cn('flex-1 rounded-xl border px-3 py-2 text-sm font-medium',
                    kind === k ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700')}>
                  {k === 'income' ? t('finances.incomeTitle') : t('finances.fixTitle')}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Switch checked={oneMonth} onChange={setOneMonth} /> {t('finances.bank.gen.oneMonth')}
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Switch checked={isTransfer} onChange={setIsTransfer} /> {t('finances.transferLabel')}
            </label>
            <p className="text-xs text-zinc-400">{t('finances.bank.gen.fixedHint', { v: eur(Math.abs(tx.amount)) })}</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
              <Button onClick={() => genFixed.mutate()} disabled={busy || !label.trim()}>{t('finances.bank.gen.createFixed')}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

interface ImportBatch {
  batch: string; filename: string; konto_id: number | null; konto_name: string | null;
  n: number; imported_at: string | null; first_date: string; last_date: string;
}

/** Compact list of imported CSV batches (filename · account · count · import date). */
function ImportBatches({ t }: { t: (k: string, o?: Record<string, unknown>) => string }) {
  const { data } = useQuery({ queryKey: ['bank-batches'], queryFn: () => api<{ batches: ImportBatch[] }>('/api/finances/bank/batches') });
  const batches = data?.batches ?? [];
  if (!batches.length) return null;
  return (
    <div className="rounded-xl border border-zinc-200 p-2.5 dark:border-zinc-800">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">{t('finances.bank.imports')}</div>
      <ul className="flex flex-col gap-1">
        {batches.map(b => (
          <li key={b.batch} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <FileText size={12} className="shrink-0 text-zinc-400" />
            <span className="min-w-0 flex-1 truncate" title={b.filename}>{b.filename}</span>
            {b.konto_name && <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{b.konto_name}</span>}
            <span className="shrink-0 tabular-nums text-zinc-400">{b.n}</span>
            <span className="shrink-0 tabular-nums text-zinc-400" title={t('finances.bank.importedOn')}>{b.imported_at ? ddmmyyyy(b.imported_at.slice(0, 10)) : '–'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BankTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: konten } = useKonten();
  const scopeKonten = useMemo(() => (konten ?? []).filter(k => !k.is_cash), [konten]);
  const [konto, setKonto] = useUrlState('bk', '');
  const [month, setMonth] = useUrlState('bm', '');
  const [status, setStatus] = useUrlState('bs', 'all');
  const [search, setSearch] = useUrlState('bq', '');
  const [highlightId] = useUrlState('bhl', ''); // deep-link: highlight one booking
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [linkTx, setLinkTx] = useState<BankTx | null>(null);
  const [genTx, setGenTx] = useState<BankTx | null>(null);
  const qs = new URLSearchParams();
  if (konto) qs.set('konto', konto);
  if (month) qs.set('month', month);
  if (status !== 'all') qs.set('status', status);
  if (search.trim()) qs.set('q', search.trim());
  const { data, isLoading } = useQuery({
    queryKey: ['bank-tx', konto, month, status, search],
    queryFn: () => api<{ items: BankTx[]; counts: { all: number; open: number; fixed: number; receipt: number; income: number } }>(`/api/finances/bank?${qs.toString()}`),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['bank-tx'] });
    void qc.invalidateQueries({ queryKey: ['bank-candidates'] });
  };
  const flag = useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) => api(`/api/finances/bank/${id}/flag`, { method: 'POST', body: { flag: on } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bank-tx'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const link = useMutation({
    // Debit → receipt (einkauf_id); credit → income row (income_id).
    mutationFn: (id: number) => api(`/api/finances/bank/${linkTx!.id}/link`, { method: 'POST', body: linkTx!.amount > 0 ? { income_id: id } : { einkauf_id: id } }),
    onSuccess: () => { invalidate(); setLinkTx(null); toast(t('finances.bank.linkedToast'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const unlink = useMutation({
    mutationFn: (id: number) => api(`/api/finances/bank/${id}/unlink`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const rematch = useMutation({
    mutationFn: () => api<{ linked: number; suggested: number }>('/api/finances/bank/rematch', { method: 'POST', body: { konto_id: konto ? Number(konto) : null } }),
    onSuccess: (r) => { invalidate(); toast(t('finances.bank.rematchToast', { n: r.linked, s: r.suggested }), (r.linked || r.suggested) ? 'success' : 'info'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const approve = useMutation({
    mutationFn: (id: number) => api(`/api/finances/bank/${id}/suggestion/approve`, { method: 'POST' }),
    onSuccess: () => { invalidate(); void qc.invalidateQueries({ queryKey: ['fin-month'] }); toast(t('finances.bank.approvedToast'), 'success'); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const dismiss = useMutation({
    mutationFn: (id: number) => api(`/api/finances/bank/${id}/suggestion/dismiss`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bank-tx'] }),
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const items = data?.items ?? [];
  const c = data?.counts;
  const chips: { key: 'all' | 'open' | 'fixed' | 'receipt' | 'income'; n?: number }[] = [
    { key: 'all', n: c?.all }, { key: 'open', n: c?.open }, { key: 'receipt', n: c?.receipt }, { key: 'income', n: c?.income }, { key: 'fixed', n: c?.fixed },
  ];
  const hasActiveFilters = !!konto || !!month || status !== 'all';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <Input className="pl-9 pr-9" placeholder={t('finances.bank.search')} value={search} onChange={e => setSearch(e.target.value)} />
            {search && (
              <button onClick={() => setSearch('')} title={t('common.clear')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
                <X size={15} />
              </button>
            )}
          </div>
          <button type="button" onClick={() => setFiltersOpen(o => !o)} title={t('receipts.filters')} aria-pressed={filtersOpen}
            className={cn('relative flex shrink-0 items-center rounded-xl border px-2.5 py-2 transition',
              filtersOpen ? 'border-emerald-500 bg-emerald-50 text-emerald-600 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
                : 'border-zinc-200 text-zinc-400 hover:text-zinc-600 dark:border-zinc-800')}>
            <SlidersHorizontal size={16} />
            {hasActiveFilters && !filtersOpen && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-950" />}
          </button>
        </div>
        {filtersOpen && (
          <>
            {/* Stacks on mobile so the account name isn't truncated ("all accoun…") and
                the clear-✕ never overlaps the native month picker's own dropdown arrow. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <Select value={konto} onChange={e => setKonto(e.target.value)} className="w-full min-w-0 sm:flex-1">
                <option value="">{t('finances.bank.allKonten')}</option>
                {scopeKonten.map(k => <option key={k.id} value={k.id}>{scopeLabelOf(t, k)}</option>)}
              </Select>
              <div className="flex items-center gap-2">
                {/* Calendar icon is on the LEFT only (the native picker's own control is on
                    the right); the clear-✕ is a SEPARATE button, never overlapping it. */}
                <div className="relative min-w-0 flex-1 sm:w-[10.5rem] sm:flex-none">
                  <Calendar size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                  <Input type="month" value={month} onChange={e => setMonth(e.target.value)} aria-label={t('finances.bank.monthFilter')}
                    className="w-full cursor-pointer pl-8" title={t('finances.bank.monthFilter')} />
                </div>
                {month && <button type="button" onClick={() => setMonth('')} title={t('common.clear')}
                  className="shrink-0 rounded-xl border border-zinc-200 p-2 text-zinc-400 hover:text-zinc-600 dark:border-zinc-800 dark:hover:text-zinc-200"><X size={15} /></button>}
                <button onClick={() => rematch.mutate()} disabled={rematch.isPending} title={t('finances.bank.rematch')}
                  className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-zinc-300 px-2.5 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                  <RefreshCw size={14} className={cn(rematch.isPending && 'animate-spin')} /> {t('finances.bank.rematch')}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {chips.map(ch => (
                <button key={ch.key} onClick={() => setStatus(ch.key)}
                  className={cn('rounded-full border px-2.5 py-1 text-xs font-medium',
                    status === ch.key ? 'border-transparent bg-emerald-600 text-white' : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300')}>
                  {t(`finances.bank.filter_${ch.key}`)}{ch.n != null ? ` · ${ch.n}` : ''}
                </button>
              ))}
            </div>
            <ImportBatches t={t} />
          </>
        )}
      </div>
      {isLoading ? <Spinner /> : !items.length ? (
        <Card className="p-4 text-center text-xs text-zinc-400">{search ? t('finances.bank.noSearchResults') : t('finances.bank.empty')}</Card>
      ) : (
        <>
          <p className="-mb-1 text-[11px] text-zinc-400">{t('finances.bank.flagHint')}</p>
          <div className="flex flex-col gap-2">
            {items.map(tx => <BankRow key={tx.id} tx={tx} t={t} highlight={highlightId !== '' && String(tx.id) === highlightId} onOpen={id => navigate(`/receipts/${id}`)} onOpenFixed={b => navigate(`/finanzen?tab=monat&m=${b.fixed!.month}&fx=${b.fixed!.id}`)} onLink={setLinkTx} onUnlink={unlink.mutate} onFlag={(id, on) => flag.mutate({ id, on })} onGenerate={setGenTx} onApprove={approve.mutate} onDismiss={dismiss.mutate} />)}
          </div>
        </>
      )}
      {linkTx && <BankLinkPicker tx={linkTx} t={t} onClose={() => setLinkTx(null)} onPick={link.mutate} onApprove={approve.mutate} />}
      {genTx && <BankGenerateModal tx={genTx} t={t} onClose={() => setGenTx(null)}
        onDone={() => {
          setGenTx(null);
          invalidate();
          void qc.invalidateQueries({ queryKey: ['fixed-costs'] });
          void qc.invalidateQueries({ queryKey: ['fin-month'] });
          void qc.invalidateQueries({ queryKey: ['receipts'] });
        }} />}
    </div>
  );
}

/** A one-off = a single-month bounded fixed_cost (start & end in the same month), e.g. a
 *  generated one-time income ("…Spesen") or cost. Not a recurring plan → kept OUT of the
 *  manage lists; it lives in its month in the Monat view (+ a collapsed section here). */
const isOneOff = (c: FixedCost): boolean => c.end_date != null && c.start_date.slice(0, 7) === c.end_date.slice(0, 7);

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
    // A fixed cost can carry a bank-tx link (generate-fixed), so its create/edit/
    // delete changes an Auszüge line's status — keep that list fresh too.
    void qc.invalidateQueries({ queryKey: ['bank-tx'] });
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
        // Only send the pairing on an existing transfer: on PATCH it preserves
        // (or re-sets) the link; a brand-new row can't pair before it has an id.
        ...(d.id ? { counterpart_id: d.is_transfer ? d.counterpart_id : null } : {}),
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

  // Single-month one-offs live in their month (Monat view) + a collapsed section below,
  // newest first — so the manage lists show only recurring fix costs + income plans.
  const oneOffs = useMemo(() => (costs ?? []).filter(isOneOff).sort((a, b) => b.start_date.localeCompare(a.start_date)), [costs]);

  // Group RECURRING costs by konto: household (shared) first, then each person.
  const groups = useMemo(() => {
    const byKonto = new Map<number, { konto: KontoLite | undefined; items: FixedCost[] }>();
    for (const k of scopeKonten) byKonto.set(k.id, { konto: k, items: [] });
    for (const c of (costs ?? []).filter(c => !isOneOff(c))) {
      if (c.konto_id == null) continue;
      if (!byKonto.has(c.konto_id)) byKonto.set(c.konto_id, { konto: konten?.find(k => k.id === c.konto_id), items: [] });
      byKonto.get(c.konto_id)!.items.push(c);
    }
    return [...byKonto.values()].sort((a, b) =>
      (b.konto?.is_shared ? 1 : 0) - (a.konto?.is_shared ? 1 : 0) ||
      (a.konto?.owner ?? '').localeCompare(b.konto?.owner ?? ''));
  }, [costs, konten, scopeKonten]);

  // Household-wide recurring total: excludes income, internal transfers (Umbuchung —
  // not real spend) AND one-offs (not a recurring monthly commitment).
  const monthlyTotal = (costs ?? []).filter(c => c.active && c.kind !== 'income' && !c.is_transfer && !isOneOff(c)).reduce((s, c) => s + amortized(c.monthly_eur, c.frequency), 0);

  if (isLoading || !konten) return <Spinner />;

  return (
    <div className="flex flex-col gap-4">
      <PayslipUpload scopeKonten={scopeKonten} />
      <BankUpload scopeKonten={scopeKonten} />
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
                      {c.counterpart_label && <span className="truncate text-violet-600 dark:text-violet-400" title={c.counterpart_konto ?? undefined}>↔ {c.counterpart_label}</span>}
                      {c.frequency !== 'monthly' && <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">{t(`finances.freq.${c.frequency}`)} · {eur(c.monthly_eur)}</span>}
                      {c.category_path && <span className="truncate">{c.category_path.split('/').pop()}</span>}
                      {!c.expect_receipt && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t('finances.noReceiptBadge')}</span>}
                      {!c.active && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{t('finances.inactive')}</span>}
                      {c.start_date && c.start_date > today() && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">{t('finances.from')} {ddmmyyyy(c.start_date)}</span>}
                      {c.end_date && <span>{t('finances.until')} {ddmmyyyy(c.end_date)}</span>}
                    </div>
                  </div>
                  <span className={cn('shrink-0 text-sm font-semibold', c.kind === 'income' && 'text-emerald-600 dark:text-emerald-500')}>{c.kind === 'income' ? '+' : ''}{eur(amortized(c.monthly_eur, c.frequency))}<span className="text-xs font-normal text-zinc-400">{t('finances.perMonth')}</span></span>
                  <button onClick={() => setModal({ id: c.id, label: c.label, monthly_eur: String(c.monthly_eur).replace('.', ','), kind: c.kind, frequency: c.frequency, is_transfer: c.is_transfer, konto_id: String(c.konto_id ?? ''), category_path: c.category_path, start_date: c.start_date, end_date: c.end_date ?? '', active: c.active, expect_receipt: c.expect_receipt, match_merchant: c.match_merchant ?? '', counterpart_id: c.counterpart_id })}
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
      {!groups.some(g => g.items.length) && !oneOffs.length && <EmptyState>{t('finances.empty')}</EmptyState>}

      {oneOffs.length > 0 && (
        <Section title={t('finances.oneOffTitle')} count={oneOffs.length} defaultOpen={false}>
          {oneOffs.map(c => (
            <Card key={c.id} className={cn('flex items-center gap-3 p-3', !c.active && 'opacity-50')}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.label}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px]', c.kind === 'income' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-zinc-100 dark:bg-zinc-800')}>{c.kind === 'income' ? t('finances.incomeTitle') : t('finances.fixTitle')}</span>
                  <span>{c.start_date.slice(5, 7)}/{c.start_date.slice(0, 4)}</span>
                  {c.konto_name && <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">{c.konto_name}</span>}
                  {c.is_transfer && <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">{t('finances.transferBadge')}</span>}
                </div>
              </div>
              <span className={cn('shrink-0 text-sm font-semibold', c.kind === 'income' && 'text-emerald-600 dark:text-emerald-500')}>{c.kind === 'income' ? '+' : ''}{eur(c.monthly_eur)}</span>
              <button onClick={() => setModal({ id: c.id, label: c.label, monthly_eur: String(c.monthly_eur).replace('.', ','), kind: c.kind, frequency: c.frequency, is_transfer: c.is_transfer, konto_id: String(c.konto_id ?? ''), category_path: c.category_path, start_date: c.start_date, end_date: c.end_date ?? '', active: c.active, expect_receipt: c.expect_receipt, match_merchant: c.match_merchant ?? '', counterpart_id: c.counterpart_id })}
                className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800" title={t('common.edit')}><Pencil size={15} /></button>
              <button onClick={() => remove.mutate(c)} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30" title={t('common.delete')}><Trash2 size={15} /></button>
            </Card>
          ))}
        </Section>
      )}

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
              <Switch checked={modal.is_transfer} onChange={v => setModal({ ...modal, is_transfer: v, counterpart_id: v ? modal.counterpart_id : null })} /> {t('finances.transferLabel')}
            </label>
            <p className="-mt-2 pl-11 text-xs text-zinc-400">{t('finances.transferHint')}</p>
            {modal.is_transfer && <CounterpartField draft={modal} setDraft={setModal} costs={costs ?? []} scopeKonten={scopeKonten} />}
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
