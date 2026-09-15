import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/auth';
import { Card, Button } from '../components/ui';
import { cn } from '../lib/utils';

/**
 * Finanzen → Konten: what each account holds, and every movement that got it there.
 *
 * The balance is a projection, not a statement from the bank: an entered anchor plus the bookings
 * since, plus the receipts the bank has not reported yet. It can therefore be AHEAD of what the
 * banking app shows, which is the whole point — a household that only learns about a low balance
 * when the bank does, learns too late.
 */

type Account = {
  id: number; name: string; account_type: string;
  balance: number | null;
  balance_start: number | null; balance_start_date: string | null;
  low_threshold: number | null; low_notified: boolean;
  watermark: string | null;
  /** Receipts before the watermark with no booking attached — assumed already at the bank. */
  assumed_booked: number;
};
type Movement = {
  kind: 'buchung' | 'beleg'; id: number; date: string;
  amount: number; who: string | null; receipt_id: number | null; balance: number;
};

/** Checked by default: the two Martin actually watches. The rest stay one click away. */
const DEFAULT_TYPES = ['giro', 'tagesgeld'];
const TYPE_LABEL: Record<string, string> = {
  giro: 'Girokonto', tagesgeld: 'Tagesgeld', kreditkarte: 'Kreditkarte',
  paypal: 'PayPal', krypto: 'Krypto', depot: 'Depot',
};

const eur = (n: number) =>
  n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const day = (iso: string) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.';

/** Yellow-ringed hit, the same treatment the receipt list uses for a search match. */
function Hit({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded border border-amber-400 bg-amber-200 px-0.5 text-inherit dark:border-amber-500 dark:bg-amber-900/70">
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  );
}

export default function KontenTab() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [types, setTypes] = useState<string[]>(DEFAULT_TYPES);
  const [sel, setSel] = useState<number | null>(null);
  const [selMove, setSelMove] = useState<number | null>(null);
  const [q, setQ] = useState('');

  const { data: accounts } = useQuery<Account[]>({
    queryKey: ['finance-accounts'],
    queryFn: () => api('/api/finances/accounts'),
  });

  const visible = useMemo(
    () => (accounts ?? []).filter(a => types.includes(a.account_type)),
    [accounts, types]);

  const current = visible.find(a => a.id === sel) ?? visible[0] ?? null;

  const { data: detail } = useQuery<{ start: number | null; start_date: string | null; watermark: string | null; movements: Movement[] }>({
    queryKey: ['finance-account-movements', current?.id],
    queryFn: () => api(`/api/finances/accounts/${current!.id}/movements`),
    enabled: !!current,
  });

  const setBalance = useMutation({
    mutationFn: (body: { balance: number | null; date: string | null }) =>
      api(`/api/finances/accounts/${current!.id}/balance`, { method: 'PATCH', body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['finance-accounts'] }); void qc.invalidateQueries({ queryKey: ['finance-account-movements'] }); },
  });
  const setThreshold = useMutation({
    mutationFn: (threshold: number | null) =>
      api(`/api/finances/accounts/${current!.id}/threshold`, { method: 'PATCH', body: { threshold } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['finance-accounts'] }),
  });

  const moves = useMemo(() => {
    const all = detail?.movements ?? [];
    if (!q) return all;
    return all.filter(m => (m.who ?? '').toLowerCase().includes(q.toLowerCase()));
  }, [detail, q]);

  const picked = selMove !== null ? moves.find(m => m.id === selMove && true) : undefined;
  const shownBalance = picked ? picked.balance : current?.balance ?? null;
  const under = current?.low_threshold != null && shownBalance != null && shownBalance < current.low_threshold;

  return (
    <div className="flex flex-col gap-3">
      {/* Filters + search */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="konten-search"
          value={q}
          onChange={e => { setQ(e.target.value); setSelMove(null); }}
          placeholder="Suchen: Lidl, Miete, Amazon …"
          className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-400 dark:border-zinc-800 dark:bg-zinc-900"
        />
        <div className="flex flex-wrap gap-1.5">
          {Object.keys(TYPE_LABEL).map(tp => {
            const on = types.includes(tp);
            return (
              <button key={tp} type="button" aria-pressed={on}
                onClick={() => setTypes(s => on ? s.filter(x => x !== tp) : [...s, tp])}
                className={cn('rounded-full border px-2.5 py-1 text-xs transition-colors',
                  on ? 'border-emerald-400 bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                     : 'border-zinc-200 text-zinc-500 dark:border-zinc-800')}>
                {TYPE_LABEL[tp]}
              </button>
            );
          })}
        </div>
      </div>

      {under && (
        <div className="rounded-xl border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <b>{current!.name} liegt unter {eur(current!.low_threshold!)}.</b>{' '}
          Voraussichtlicher Stand {eur(shownBalance!)} — gerechnet inklusive der Belege, die die Bank
          noch nicht gemeldet hat.
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          {/* Accounts */}
          <Card className="overflow-hidden p-0">
            {visible.length === 0 && (
              <div className="p-4 text-center text-sm text-zinc-400">Kein Konto in den gewählten Typen.</div>
            )}
            {visible.map(a => (
              <button key={a.id} type="button" onClick={() => { setSel(a.id); setSelMove(null); }}
                className={cn('flex w-full items-center justify-between gap-3 border-b border-zinc-100 px-3 py-2.5 text-left last:border-b-0 dark:border-zinc-800',
                  current?.id === a.id && 'bg-emerald-50 dark:bg-emerald-950/30')}>
                <span className="min-w-0">
                  <span className="block truncate font-medium"><Hit text={a.name} q={q} /></span>
                  <span className="block text-[11px] uppercase tracking-wide text-zinc-400">{TYPE_LABEL[a.account_type] ?? a.account_type}</span>
                </span>
                <span className={cn('shrink-0 font-semibold tabular-nums',
                  a.balance === null ? 'text-zinc-400' : a.balance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
                  {a.balance === null ? 'kein Startwert' : eur(a.balance)}
                </span>
              </button>
            ))}
          </Card>

          {/* Movements */}
          <Card className="overflow-hidden p-0">
            <div className="flex items-baseline justify-between gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
              <h3 className="text-sm font-semibold">Bewegungen{current ? ` · ${current.name}` : ''}</h3>
              <span className="text-[11px] text-zinc-400">
                {detail?.watermark ? `Buchungen bis ${day(detail.watermark)}` : 'keine Buchungen'}
              </span>
            </div>
            {moves.length === 0 && (
              <div className="p-4 text-center text-sm text-zinc-400">
                {q ? `Kein Treffer für „${q}".` : 'Noch keine Bewegungen.'}
              </div>
            )}
            {moves.map(m => (
              <button key={`${m.kind}-${m.id}`} type="button"
                onClick={() => setSelMove(s => s === m.id ? null : m.id)}
                className={cn('flex w-full items-center gap-3 border-b border-l-[3px] border-zinc-100 px-3 py-2 text-left last:border-b-0 dark:border-zinc-800',
                  selMove === m.id ? 'border-l-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-l-transparent')}>
                <span className="w-12 shrink-0 text-[11px] tabular-nums text-zinc-400">{day(m.date)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate"><Hit text={m.who ?? '—'} q={q} /></span>
                  {m.kind === 'beleg' ? (
                    <span className="mt-0.5 inline-block rounded-full border border-amber-400 bg-amber-50 px-1.5 text-[10px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                      Beleg · noch nicht gebucht
                    </span>
                  ) : m.receipt_id ? (
                    <span onClick={e => { e.stopPropagation(); navigate(`/finanzen?tab=bank&tx=${m.id}`); }}
                      className="mt-0.5 inline-block cursor-pointer rounded-full border border-emerald-400 bg-emerald-50 px-1.5 text-[10px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      Beleg zugeordnet →
                    </span>
                  ) : null}
                </span>
                <span className={cn('shrink-0 font-semibold tabular-nums',
                  m.amount < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
                  {m.amount > 0 ? '+' : ''}{eur(m.amount)}
                </span>
              </button>
            ))}
          </Card>
        </div>

        {/* Balance panel */}
        <Card className="h-fit overflow-hidden p-0 lg:sticky lg:top-3">
          <div className="border-b border-zinc-100 px-3 py-4 text-center dark:border-zinc-800">
            <div className="text-[11px] text-zinc-400">
              {picked ? `Stand am ${day(picked.date)} nach dieser Bewegung` : 'Stand heute'}
            </div>
            <div className={cn('mt-0.5 text-3xl font-bold tabular-nums tracking-tight',
              shownBalance === null ? 'text-zinc-400'
                : shownBalance < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400')}>
              {shownBalance === null ? '—' : eur(shownBalance)}
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-400">
              {current?.balance_start_date
                ? `Startwert ${eur(current.balance_start ?? 0)} am ${day(current.balance_start_date)}`
                : 'Kein Startwert hinterlegt — ohne ihn kennt VDS nur die Veränderung.'}
            </div>
          </div>

          {picked ? (
            <div className="px-3 py-2 text-sm">
              <Row k="Betrag" v={`${picked.amount > 0 ? '+' : ''}${eur(picked.amount)}`} />
              <Row k="Herkunft" v={picked.kind === 'beleg' ? 'Beleg (noch nicht gebucht)' : 'Kontobuchung'} />
              <Row k="Beleg" v={
                picked.receipt_id
                  ? <button className="font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                      onClick={() => navigate(picked.kind === 'beleg' ? `/receipts/${picked.receipt_id}` : `/finanzen?tab=bank&tx=${picked.id}`)}>
                      {picked.kind === 'beleg' ? 'Beleg öffnen' : '→ Auszüge'}
                    </button>
                  : 'keiner zugeordnet'} />
            </div>
          ) : current ? (
            <div className="flex flex-col gap-2 px-3 py-3 text-sm">
              {current.assumed_booked > 0 && (
                <p className="rounded-lg border border-zinc-200 px-2 py-1.5 text-[11px] leading-snug text-zinc-500 dark:border-zinc-800">
                  <b>{current.assumed_booked} Belege</b> liegen vor der letzten Buchung ohne zugeordnete
                  Buchung — sie gelten als von der Bank bereits gemeldet und zählen deshalb nicht noch
                  einmal. Fehlt einer davon wirklich in den Bankdaten, weicht der Stand ab.
                </p>
              )}
              <BalanceForm current={current} onSave={(b, d) => setBalance.mutate({ balance: b, date: d })} busy={setBalance.isPending} />
              {user?.is_admin ? (
                <ThresholdForm current={current} onSave={v => setThreshold.mutate(v)} busy={setThreshold.isPending} />
              ) : (
                <Row k="Schwelle" v={current.low_threshold != null ? `${eur(current.low_threshold)} (nur Admin)` : 'keine'} />
              )}
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-zinc-100 py-1.5 last:border-b-0 dark:border-zinc-800">
      <span className="text-zinc-500">{k}</span>
      <span className="tabular-nums">{v}</span>
    </div>
  );
}

function BalanceForm({ current, onSave, busy }: { current: Account; onSave: (b: number | null, d: string | null) => void; busy: boolean }) {
  const [v, setV] = useState(current.balance_start != null ? String(current.balance_start) : '');
  const [d, setD] = useState(current.balance_start_date ?? new Date().toISOString().slice(0, 10));
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs text-zinc-500" htmlFor="bal-v">Kontostand laut Bank</label>
      <div className="flex gap-1.5">
        <input id="bal-v" inputMode="decimal" value={v} onChange={e => setV(e.target.value)} placeholder="2000,00"
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900" />
        <input id="bal-d" type="date" value={d} onChange={e => setD(e.target.value)}
          className="rounded-lg border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900" />
      </div>
      <Button disabled={busy} onClick={() => onSave(v.trim() === '' ? null : Number(v.replace(',', '.')), v.trim() === '' ? null : d)}>
        Stand übernehmen
      </Button>
      <p className="text-[11px] leading-snug text-zinc-400">
        Ab hier rechnet VDS vorwärts: Buchungen plus die Belege, die die Bank noch nicht gemeldet hat.
      </p>
    </div>
  );
}

function ThresholdForm({ current, onSave, busy }: { current: Account; onSave: (v: number | null) => void; busy: boolean }) {
  const [v, setV] = useState(current.low_threshold != null ? String(current.low_threshold) : '');
  return (
    <div className="flex flex-col gap-1.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
      <label className="text-xs text-zinc-500" htmlFor="thr-v">Warnen unter</label>
      <div className="flex gap-1.5">
        <input id="thr-v" inputMode="decimal" value={v} onChange={e => setV(e.target.value)} placeholder="2000"
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900" />
        <Button disabled={busy} onClick={() => onSave(v.trim() === '' ? null : Number(v.replace(',', '.')))}>Setzen</Button>
      </div>
      <p className="text-[11px] leading-snug text-zinc-400">
        Mail und Push an alle Admins, einmal pro Unterschreitung — nicht pro Beleg.
      </p>
    </div>
  );
}
