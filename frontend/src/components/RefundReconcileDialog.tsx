import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Paperclip, ArrowRight, CornerUpLeft } from 'lucide-react';
import { Modal, Button, Select, Input, Label } from './ui';
import { eur, cn } from '../lib/utils';
import type { RefundCandidate, RefundCandidatePosition, RefundBookPayload } from '../api/types';

const EPS = 0.02;
const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/** The n where n × refundAmount == position price (Martin's rule: a "2× Ventilator = 179,98"
 *  position is n=2 of an 89,99 refund). 0 when the price is not an integer multiple of the refund. */
function multipleN(price: number, amount: number): number {
  if (!(amount > 0) || !(price > 0)) return 0;
  const n = Math.round(price / amount);
  return n >= 1 && n <= 100 && Math.abs(price - n * amount) <= EPS ? n : 0;
}
const isIntMenge = (p: RefundCandidatePosition): boolean => p.menge != null && Number.isInteger(p.menge) && p.menge >= 1;
const unitPrice = (p: RefundCandidatePosition): number => {
  const P = p.preis ?? 0;
  const M = p.menge && p.menge > 0 ? p.menge : 1;
  return P / M;
};

export interface RefundReconcileDialogProps {
  amount: number;                 // the refund € (bank credit / mail amount); seed for the editable field
  editableAmount?: boolean;       // manual entry: let the user type the amount (no credit/mail to seed it)
  item?: string | null;           // refunded item text (for the hint)
  merchant?: string | null;
  mailPositions?: { name: string; preis: number | null }[] | null; // refund-mail positions → right column
  candidates: RefundCandidate[];  // receipts to book onto (manual entry passes exactly one)
  initialReceiptId?: number | null;
  booking?: boolean;
  onClose: () => void;
  onBook: (p: RefundBookPayload) => void;
  onViewMail?: () => void;        // paperclip → open the refund mail (caller knows the endpoint)
  onLinkOnly?: (einkaufId: number) => void; // (bank flow) receipt already has a booked refund → link the credit, don't re-book
}

/** Reconcile a refund against a receipt: mark which position(s)/quantities came back (a combined
 *  line is split into "kept" + "returned" on the server), or book a pure "nur Rabatt" price cut.
 *  Red-marks positions whose price is a multiple of the refund. Used from the bank-credit assign,
 *  the mail import log, and the receipt detail — the caller supplies onBook + the candidates. */
export function RefundReconcileDialog({
  amount, editableAmount, item, merchant, mailPositions, candidates, initialReceiptId, booking, onClose, onBook, onViewMail, onLinkOnly,
}: RefundReconcileDialogProps) {
  const { t } = useTranslation();
  const [receiptId, setReceiptId] = useState<number | null>(initialReceiptId ?? candidates[0]?.id ?? null);
  const [discountOnly, setDiscountOnly] = useState(false);
  const [note, setNote] = useState('');
  const [amtStr, setAmtStr] = useState(amount > 0 ? String(amount) : '');
  const [ret, setRet] = useState<Record<number, number>>({}); // artikel_id → returned units (0 = not returned)

  const amt = round2(Number((amtStr || '0').replace(',', '.')) || 0);
  const receipt = useMemo(() => candidates.find(c => c.id === receiptId) ?? null, [candidates, receiptId]);
  const alreadyRefunded = !!onLinkOnly && receipt?.already_refunded === true; // link-the-credit instead of re-booking

  // On receipt switch, pre-select red-marked positions with the quantity the refund covers
  // (amount / unit price, clamped to the line's quantity).
  useEffect(() => {
    if (!receipt) { setRet({}); return; }
    const init: Record<number, number> = {};
    for (const p of receipt.positions) {
      if (multipleN(p.preis ?? 0, amt) > 0) {
        const P = p.preis ?? 0;
        const M = p.menge && p.menge > 0 ? p.menge : 1;
        const u = P / M;
        const maxQ = isIntMenge(p) ? (p.menge as number) : 1;
        const q = Math.max(1, Math.min(u > 0 ? Math.round(amt / u) : 1, maxQ));
        const portion = q >= M - 1e-9 ? P : round2((P * q) / M);
        // Only pre-select when the selectable quantity actually REPRODUCES the refund amount. An
        // OCR-merged "2×" line collapsed to menge=1 can't represent half, so leave it unmarked
        // (else it would pre-fill a full-line refund double the credit).
        if (amt <= 0 || Math.abs(portion - amt) <= EPS) init[p.id] = q;
      }
    }
    setRet(init);
  }, [receiptId]); // eslint-disable-line react-hooks/exhaustive-deps

  const returnedLines = useMemo(() => {
    if (!receipt) return [] as { p: RefundCandidatePosition; q: number; portion: number }[];
    return receipt.positions
      .filter(p => (ret[p.id] ?? 0) > 0)
      .map(p => {
        const q = ret[p.id];
        const P = p.preis ?? 0;
        const M = p.menge && p.menge > 0 ? p.menge : 1;
        const portion = q >= M - 1e-9 ? P : round2((P * q) / M);
        return { p, q, portion };
      });
  }, [receipt, ret]);

  const returnedTotal = round2(returnedLines.reduce((s, l) => s + l.portion, 0));
  const grossNet = receipt?.gesamt_betrag ?? null;
  const bookedAmount = discountOnly ? amt : returnedTotal;
  const newNet = grossNet != null ? round2(grossNet - bookedAmount) : null;
  const mismatch = !discountOnly && returnedLines.length > 0 && amt > 0 && Math.abs(returnedTotal - amt) > EPS;
  // In the bank/mail path the refund amount is AUTHORITATIVE — a returned-total that doesn't match it
  // (e.g. an OCR-merged line that can only be returned whole) must not be bookable. In the manual
  // path (editableAmount) the amount is derived from the lines, so a mismatch is informational only.
  const valid = !!receipt && (discountOnly ? amt > 0 : returnedLines.length > 0) && bookedAmount > 0 && !(mismatch && !editableAmount);

  const setQty = (p: RefundCandidatePosition, q: number) => setRet(r => ({ ...r, [p.id]: q }));
  const qtyOptions = (p: RefundCandidatePosition): number[] =>
    isIntMenge(p) ? Array.from({ length: p.menge as number }, (_, i) => i + 1) : [1];

  const book = () => {
    if (!receipt) return;
    if (discountOnly) {
      onBook({ einkauf_id: receipt.id, discount_only: true, amount: amt, description: note.trim() || undefined });
      return;
    }
    onBook({
      einkauf_id: receipt.id, discount_only: false, amount: returnedTotal,
      description: note.trim() || undefined,
      lines: returnedLines.map(l => ({ artikel_id: l.p.id, return_qty: l.q })),
    });
  };

  return (
    <Modal open onClose={onClose} title={t('refund.title', 'Rückerstattung zuordnen')} wide>
      <div className="flex flex-col gap-3">
        {/* summary + paperclip */}
        <div className="flex items-end justify-between gap-2">
          {editableAmount ? (
            <div className="flex-1">
              <Label>{t('refund.amountLabel', 'Erstattungsbetrag')}</Label>
              <Input type="number" step="0.01" min="0" value={amtStr} onChange={e => setAmtStr(e.target.value)} placeholder="0,00" />
            </div>
          ) : (
            <div className="text-sm text-zinc-600 dark:text-zinc-300">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">{eur(amt)}</span>
              {merchant ? <> · {merchant}</> : null}
            </div>
          )}
          {onViewMail && (
            <button type="button" onClick={onViewMail}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
              <Paperclip size={14} /> {t('refund.viewMail', 'Erstattungsmail')}
            </button>
          )}
        </div>

        {/* receipt picker (only when there is a choice) */}
        {candidates.length > 1 && (
          <div>
            <Label>{t('refund.receipt', 'Beleg')}</Label>
            <Select value={String(receiptId ?? '')} onChange={ev => setReceiptId(ev.target.value ? Number(ev.target.value) : null)}>
              {candidates.map(c => (
                <option key={c.id} value={c.id}>
                  {(c.roh_ladenname || '?')} · {c.datum}{c.gesamt_betrag != null ? ` · ${eur(c.gesamt_betrag)}` : ''}
                </option>
              ))}
            </Select>
          </div>
        )}

        {candidates.length === 0 && !editableAmount && (
          <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {t('refund.noCandidates', 'Kein passender Beleg gefunden. Öffne den Beleg direkt und nutze dort „Erstattung erfassen".')}
          </p>
        )}

        {alreadyRefunded ? (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
            {t('refund.alreadyRefunded', 'Dieser Beleg hat bereits eine gebuchte Erstattung. Die Gutschrift wird nur als Bank-Nachweis zugeordnet — es wird keine zweite Erstattung gebucht.')}
          </div>
        ) : (
        <>
        {/* discount-only toggle */}
        <label className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-zinc-50 px-3 py-2 text-sm dark:bg-zinc-800/60">
          <input type="checkbox" checked={discountOnly} onChange={e => setDiscountOnly(e.target.checked)} className="h-4 w-4" />
          <span className="text-zinc-800 dark:text-zinc-100">{t('refund.discountOnly', 'nur Rabatt')}</span>
          <span className="text-zinc-500 dark:text-zinc-400">— {t('refund.discountOnlyHint', 'Preisnachlass, kein Artikel geht zurück')}</span>
        </label>

        {discountOnly ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {t('refund.discountBody', 'Es wird eine Minus-Position über {{amount}} auf dem Beleg eingefügt; der Belegpreis sinkt entsprechend.', { amount: eur(amt) })}
          </p>
        ) : (
          <div className={cn('grid gap-3', mailPositions?.length ? 'sm:grid-cols-2' : 'grid-cols-1')}>
            {/* left: receipt positions with per-line return selector */}
            <div>
              <div className="mb-1 text-xs text-zinc-400">
                {t('refund.receiptPositions', 'Belegpositionen')}{grossNet != null ? ` · ${eur(grossNet)}` : ''}
              </div>
              <div className="flex flex-col gap-1.5">
                {receipt?.positions.map(p => {
                  const red = multipleN(p.preis ?? 0, amt) > 0;
                  const q = ret[p.id] ?? 0;
                  const active = q > 0 || red;
                  return (
                    <div key={p.id}
                      className={cn('rounded-lg border px-2.5 py-2',
                        active ? 'border-red-300 bg-red-50 dark:border-red-800/60 dark:bg-red-950/30'
                          : 'border-zinc-200 dark:border-zinc-700')}>
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn('text-sm', active ? 'text-red-700 dark:text-red-300' : 'text-zinc-800 dark:text-zinc-100')}>
                          {p.menge && p.menge !== 1 ? `${p.menge}× ` : ''}{p.name}
                        </span>
                        <span className={cn('text-sm tabular-nums', active ? 'font-medium text-red-700 dark:text-red-300' : 'text-zinc-500 dark:text-zinc-400')}>
                          {p.preis != null ? eur(p.preis) : '—'}
                        </span>
                      </div>
                      {red && (
                        <div className="mt-0.5 text-xs text-red-600 dark:text-red-400">
                          <CornerUpLeft size={12} className="mr-0.5 inline align-[-1px]" />{t('refund.matchHint', 'passt zur Erstattung')}
                        </div>
                      )}
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('refund.returnQty', 'zurück:')}</span>
                        <Select value={String(q)} onChange={ev => setQty(p, Number(ev.target.value))} className="h-7 w-auto py-0 text-xs">
                          <option value="0">—</option>
                          {qtyOptions(p).map(n => (
                            <option key={n} value={n}>{isIntMenge(p) ? `${n} ${t('refund.of', 'von')} ${p.menge}` : t('refund.wholeLine', 'ganze Position')}</option>
                          ))}
                        </Select>
                      </div>
                    </div>
                  );
                })}
                {!receipt?.positions.length && (
                  <p className="text-xs text-zinc-400">{t('refund.noPositions', 'Keine Positionen auf diesem Beleg.')}</p>
                )}
              </div>
            </div>

            {/* right: refund-mail positions (reference) */}
            {mailPositions?.length ? (
              <div>
                <div className="mb-1 text-xs text-zinc-400">{t('refund.mailPositions', 'Erstattungsmail')}</div>
                <div className="flex flex-col gap-1.5">
                  {mailPositions.map((m, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-2 dark:border-blue-900/50 dark:bg-blue-950/30">
                      <span className="text-sm text-blue-800 dark:text-blue-200">{m.name}</span>
                      <span className="text-sm tabular-nums font-medium text-blue-800 dark:text-blue-200">{m.preis != null ? eur(m.preis) : '—'}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : item ? (
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {t('refund.itemHint', 'Erstatteter Artikel laut Mail: {{item}}', { item })}
              </div>
            ) : null}
          </div>
        )}

        {/* note */}
        <div>
          <Label>{t('refund.noteLabel', 'Notiz (optional)')}</Label>
          <Input value={note} onChange={ev => setNote(ev.target.value)} placeholder={t('refund.notePlaceholder', 'z.B. Amazon Rücksendung')} />
        </div>

        {/* preview */}
        {(newNet != null || (!discountOnly && returnedLines.length > 0)) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-800/60">
            {newNet != null && (
              <span className="text-zinc-600 dark:text-zinc-300">
                {t('refund.receiptNet', 'Beleg-Netto')} <span className="text-zinc-400 line-through">{eur(grossNet as number)}</span>
                <ArrowRight size={12} className="mx-1 inline align-[-1px]" />
                <span className="font-medium text-emerald-600 dark:text-emerald-400">{eur(newNet)}</span>
              </span>
            )}
            {!discountOnly && returnedLines.length > 0 && (
              <span className={cn(mismatch ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-600 dark:text-zinc-300')}>
                {t('refund.returnedTotal', 'Rückgabe gesamt')}: {eur(returnedTotal)}
                {mismatch ? ` (${t('refund.mismatch', 'weicht von {{amount}} ab', { amount: eur(amt) })})` : ''}
              </span>
            )}
          </div>
        )}

        </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel', 'Abbrechen')}</Button>
          {alreadyRefunded ? (
            <Button onClick={() => receipt && onLinkOnly!(receipt.id)} disabled={!receipt || booking}>
              {booking ? t('common.saving', 'Speichern…') : t('refund.linkCredit', 'Gutschrift zuordnen')}
            </Button>
          ) : (
            <Button onClick={book} disabled={!valid || booking}>
              {booking ? t('common.saving', 'Speichern…') : t('refund.book', 'Rückerstattung buchen')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
