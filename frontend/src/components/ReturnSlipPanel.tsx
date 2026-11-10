import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Clock, Package, PackageCheck, Truck } from 'lucide-react';
import { api } from '../api/client';
import type { ReceiptReturn, RetoureInfo } from '../api/types';
import { toast } from './Toast';
import { cn, eur, fmtDate } from '../lib/utils';

const box = 'flex flex-col gap-2 rounded-xl border px-3 py-2.5 text-sm';
const muted = 'text-zinc-500 dark:text-zinc-400';

/** A scanned return slip (the carrier's drop-off receipt): which parcels it proves were handed
 *  in, which returns that closed (their position went to 0 € on the original receipt), and —
 *  when more returns were open than slips scanned — the choice of which one it belongs to. */
export function ReturnSlipPanel({ receiptId, info, canWrite }: { receiptId: number; info: RetoureInfo; canWrite: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const choose = useMutation({
    mutationFn: (ledgerId: number) => api<RetoureInfo>(`/api/receipts/${receiptId}/retoure`, { method: 'POST', body: { ledger_id: ledgerId } }),
    onSuccess: (res) => {
      // Handed in either way; "closed" only when the position on the original receipt went to 0.
      const note = res.closed[res.closed.length - 1]?.note;
      toast(note ? t('retoure.chosenOpen') : t('retoure.chosen'), note ? 'info' : 'success');
      // Prefix match: refreshes this slip AND the original receipt whose position just went to 0.
      void qc.invalidateQueries({ queryKey: ['receipt'] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const first = info.slips[0];
  const recipient = first?.recipient;
  const sameDrop = info.slips.every(s => s.datum === first?.datum && s.uhrzeit === first?.uhrzeit && s.filiale === first?.filiale);
  const when = (d: string | null, h: string | null) => [d ? fmtDate(d, i18n.language) : null, h].filter(Boolean).join(', ');

  return (
    <div className={cn(box, 'border-sky-200 bg-sky-50/60 dark:border-sky-800/60 dark:bg-sky-950/30')}>
      <div className="flex items-center gap-2 font-medium text-sky-800 dark:text-sky-300">
        <Truck size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">
          {t('retoure.title', { count: info.slips.length })}
          {recipient && <span className="font-normal"> · {recipient}</span>}
        </span>
      </div>

      {sameDrop && first && (when(first.datum, first.uhrzeit) || first.filiale) && (
        <div className={cn('text-xs', muted)}>
          {t('retoure.handedIn', { when: when(first.datum, first.uhrzeit) })}
          {first.filiale && <> · {first.filiale}</>}
        </div>
      )}
      <ul className="flex flex-col gap-0.5">
        {info.slips.map((s, i) => (
          <li key={s.tracking ?? i} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className={muted}>{s.carrier ?? '?'}</span>
            <span className="tabular font-mono text-zinc-700 dark:text-zinc-200">{s.tracking ?? t('retoure.noTracking')}</span>
            {!sameDrop && <span className={muted}>{when(s.datum, s.uhrzeit)}{s.filiale ? ` · ${s.filiale}` : ''}</span>}
          </li>
        ))}
      </ul>

      {info.closed.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-t border-sky-200 pt-2 dark:border-sky-800/60">
          {info.closed.map(c => (
            <li key={c.ledgerId} className="flex flex-col gap-0.5">
              <div className="flex items-start gap-2">
                <PackageCheck size={15} className={cn('mt-0.5 shrink-0', c.note ? 'text-amber-500' : 'text-emerald-600 dark:text-emerald-500')} />
                <span className="min-w-0 flex-1 break-words">{c.item ?? t('retoure.unknownItem')}</span>
                {c.amount != null && <span className="tabular shrink-0 font-medium">{eur(c.amount)}</span>}
              </div>
              <div className="pl-[23px] text-xs">
                {c.einkaufId != null && (
                  <Link to={`/receipts/${c.einkaufId}`} className="font-medium text-emerald-600 hover:underline dark:text-emerald-500">
                    {t('retoure.onReceipt', { id: c.einkaufId })}
                  </Link>
                )}
                {c.note && <span className="text-amber-700 dark:text-amber-400">{c.einkaufId != null ? ' · ' : ''}{c.note}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!!info.partners?.length && (
        <div className={cn('text-xs', muted)}>
          {t('retoure.togetherWith')}{' '}
          {info.partners.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <Link to={`/receipts/${id}`} className="font-medium text-sky-700 hover:underline dark:text-sky-400">#{id}</Link>
            </span>
          ))}
          . {t('retoure.togetherHint')}
        </div>
      )}

      {info.pending && info.pending.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-sky-200 pt-2 dark:border-sky-800/60">
          <div className="font-medium text-amber-700 dark:text-amber-400">{t('retoure.choose', { count: info.pendingCount })}</div>
          {info.pending.map(p => (
            <button key={p.ledgerId} type="button" disabled={!canWrite || choose.isPending}
              onClick={() => choose.mutate(p.ledgerId)}
              className="flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-left hover:border-emerald-400 hover:bg-emerald-50 disabled:cursor-default disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-emerald-950/30">
              <Package size={15} className="shrink-0 text-zinc-400" />
              <span className="min-w-0 flex-1">
                <span className="break-words">{p.item ?? t('retoure.unknownItem')}</span>
                {p.orderRef && <span className={cn('block text-[11px]', muted)}>{p.orderRef}</span>}
              </span>
              {p.amount != null && <span className="tabular shrink-0 font-medium">{eur(p.amount)}</span>}
            </button>
          ))}
        </div>
      )}

      {/* While the choice is shown, the question says it all; the note would repeat it. */}
      {info.note && !info.pending?.length && (
        <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{info.note}</span>
        </div>
      )}
    </div>
  );
}

/** On the ORIGINAL receipt: how far each booked return has come — handed in (scanned slip or
 *  Amazon's drop-off mail) and refunded (bank credit in the CSV, or Amazon store credit). */
export function ReturnStatusPanel({ returns }: { returns: ReceiptReturn[] }) {
  const { t, i18n } = useTranslation();
  if (!returns.length) return null;
  const step = (ok: boolean, label: ReactNode) => (
    <span className={cn('inline-flex items-center gap-1', ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}>
      {ok ? <Check size={12} /> : <Clock size={12} />} {label}
    </span>
  );
  return (
    <div className={cn(box, 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900')}>
      {returns.map((r, i) => (
        <div key={r.refund_artikel_id ?? `r${i}`} className="flex flex-col gap-0.5">
          <div className="flex items-start gap-2">
            <Package size={15} className="mt-0.5 shrink-0 text-zinc-400" />
            <span className="min-w-0 flex-1 break-words font-medium">{t('retoure.returnOf', { item: r.item ?? t('retoure.unknownItem') })}</span>
            {r.amount != null && <span className="tabular shrink-0">{eur(r.amount)}</span>}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-[23px] text-xs">
            {r.dropoff_at
              ? step(true, r.dropoff_einkauf_id != null
                  ? <Link to={`/receipts/${r.dropoff_einkauf_id}`} className="hover:underline">{t('retoure.droppedSlip', { date: fmtDate(r.dropoff_at, i18n.language), id: r.dropoff_einkauf_id })}</Link>
                  : t('retoure.droppedMail', { date: fmtDate(r.dropoff_at, i18n.language) }))
              : step(false, t('retoure.notDropped'))}
            {r.confirmed_at
              ? step(true, t(r.confirmed_by === 'mail' ? 'retoure.confirmedCredit' : 'retoure.confirmedBank', { date: fmtDate(r.confirmed_at, i18n.language) }))
              : step(false, t('retoure.awaitingRefund'))}
          </div>
        </div>
      ))}
    </div>
  );
}
