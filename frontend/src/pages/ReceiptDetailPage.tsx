import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Pencil, Trash2, AlertTriangle, ScanLine, Plus, ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch';
import { api } from '../api/client';
import type { Artikel, ReceiptDetail } from '../api/types';
import { Card, Spinner, Badge, Modal, Input, Label, Button } from '../components/ui';
import { ArticleEditModal } from '../components/ArticleEditModal';
import { AddArticleModal } from '../components/AddArticleModal';
import { ConsumerDots } from '../components/ConsumerChips';
import { CanonicalIcon } from '../components/IconPicker';
import { eur, fmtDate } from '../lib/utils';

export function ReceiptDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Artikel | null>(null);
  const [editReceipt, setEditReceipt] = useState(false);
  const [adding, setAdding] = useState(false);
  const [imgVersion, setImgVersion] = useState(0); // cache-buster after rotate

  const deleteReceipt = useMutation({
    mutationFn: () => api(`/api/receipts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      void qc.invalidateQueries({ queryKey: ['stores'] });
      navigate('/receipts');
    },
  });

  const rotate = useMutation({
    mutationFn: () => api(`/api/receipts/${id}/rotate`, { method: 'POST' }),
    onSuccess: () => setImgVersion(v => v + 1),
    onError: (err: Error) => alert(`Drehen fehlgeschlagen: ${err.message}`),
  });

  const reocr = useMutation({
    mutationFn: () => api<{ items: number; confidence: number }>(`/api/receipts/${id}/reocr`, { method: 'POST' }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['receipt', id] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      alert(t('receiptDetail.reocrDone', { count: res.items, confidence: Math.round(res.confidence * 100) }));
    },
    onError: (err: Error) => alert(`OCR fehlgeschlagen: ${err.message}`),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['receipt', id],
    queryFn: () => api<ReceiptDetail>(`/api/receipts/${id}`),
    enabled: !!id,
  });

  const { data: neighbors } = useQuery({
    queryKey: ['receipt-neighbors', id],
    queryFn: () => api<{ prev_id: number | null; next_id: number | null }>(`/api/receipts/${id}/neighbors`),
    enabled: !!id,
  });

  const goPrev = () => neighbors?.prev_id && navigate(`/receipts/${neighbors.prev_id}`);
  const goNext = () => neighbors?.next_id && navigate(`/receipts/${neighbors.next_id}`);

  // Keyboard: ← / → arrow navigation, ignored when typing in a field or a modal is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || editReceipt || adding) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neighbors, editing, editReceipt, adding]);

  // Touch: horizontal swipe (>60px, mostly horizontal) navigates
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (editing || editReceipt || adding) return;
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    touchStart.current = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx > 0) goPrev(); else goNext();
    }
  };

  if (isLoading) return <Spinner />;
  if (!data) return null;

  // Sum of line totals — flag if it doesn't match the receipt's printed gesamt_betrag.
  const itemSum = data.artikel.reduce((acc, a) => {
    const p = parseFloat((a.preis ?? '').toString().replace(',', '.'));
    return acc + (Number.isFinite(p) ? p : 0);
  }, 0);
  const printedTotal = parseFloat((data.gesamt_betrag ?? '').toString().replace(',', '.'));
  const totalKnown = Number.isFinite(printedTotal);
  const diff = totalKnown ? itemSum - printedTotal : 0;
  const mismatch = totalKnown && Math.abs(diff) > 0.01;

  return (
    <div className="flex flex-col gap-4" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="flex items-center gap-2 sm:gap-3">
        <Link to="/receipts" className="shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <ArrowLeft size={20} />
        </Link>
        <button
          onClick={goPrev}
          disabled={!neighbors?.prev_id}
          className="hidden shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800 sm:block"
          title={t('receiptDetail.prev')}
        >
          <ChevronLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="truncate text-lg font-bold">{data.roh_ladenname ?? '?'}</h1>
            <span className="tabular shrink-0 text-xs font-medium text-zinc-400 dark:text-zinc-500">#{data.id}</span>
          </div>
          <div className="text-sm text-zinc-500">
            {fmtDate(data.datum, i18n.language)} · <span className="tabular font-semibold text-emerald-600 dark:text-emerald-500">{eur(data.gesamt_betrag)}</span>
          </div>
        </div>
        <button
          onClick={goNext}
          disabled={!neighbors?.next_id}
          className="hidden shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800 sm:block"
          title={t('receiptDetail.next')}
        >
          <ChevronRight size={20} />
        </button>
        <button
          onClick={() => rotate.mutate()}
          disabled={rotate.isPending || !data.bild_pfad}
          className="shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
          title={t('receiptDetail.rotate')}
        >
          <RotateCw size={18} className={rotate.isPending ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => { if (confirm(t('receiptDetail.reocrConfirm'))) reocr.mutate(); }}
          disabled={reocr.isPending || !data.bild_pfad}
          className="shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
          title={t('receiptDetail.reocr')}
        >
          <ScanLine size={18} className={reocr.isPending ? 'animate-pulse' : ''} />
        </button>
        <button
          onClick={() => setEditReceipt(true)}
          className="shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title={t('receiptEdit.title')}
        >
          <Pencil size={18} />
        </button>
        <button
          onClick={() => { if (confirm(t('receiptEdit.deleteConfirm'))) deleteReceipt.mutate(); }}
          disabled={deleteReceipt.isPending}
          className="shrink-0 rounded-xl p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
          title={t('receiptEdit.delete')}
        >
          <Trash2 size={18} />
        </button>
      </div>

      {mismatch && (
        <div
          className="flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-300"
          title={t('receiptDetail.mismatchHint')}
        >
          <AlertTriangle size={16} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <span className="font-medium">{t('receiptDetail.mismatch')}: </span>
            <span className="tabular">{t('receiptDetail.sumLabel')} {eur(itemSum)} </span>
            <span className="tabular">{t('receiptDetail.printedLabel')} {eur(printedTotal)} </span>
            <span className="tabular font-semibold">({diff > 0 ? '+' : ''}{eur(diff)})</span>
          </div>
        </div>
      )}

      <ReceiptEditModal receipt={data} open={editReceipt} onClose={() => setEditReceipt(false)} />

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* Receipt image — zoomable in place so items list stays visible */}
        <div className="lg:sticky lg:top-[60px] lg:self-start">
          {data.bild_pfad ? (
            <ZoomableReceiptImage
              src={imgVersion ? `${data.bild_pfad}?v=${imgVersion}` : data.bild_pfad}
            />
          ) : (
            <div className="flex h-48 items-center justify-center rounded-2xl bg-zinc-100 text-sm text-zinc-400 dark:bg-zinc-900">
              {t('receipts.noImage')}
            </div>
          )}
        </div>

        {/* Line items */}
        <div className="flex min-w-0 flex-col gap-1.5">
          {data.artikel.map(a => (
            <Card key={a.id} onClick={() => setEditing(a)} className="flex min-w-0 items-center gap-2 px-2.5 py-2.5 sm:gap-3 sm:px-3">
              {a.canonical_name && <CanonicalIcon name={a.canonical_name} size={32} />}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium">{a.canonical_name ?? a.ai_guess ?? a.name}</span>
                  <ConsumerDots ids={a.consumers} />
                </div>
                {a.original_text && (
                  <div className="truncate font-mono text-[11px] text-zinc-400">{a.original_text}</div>
                )}
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {a.category_path && <Badge>{a.category_path.split('/').pop()}</Badge>}
                  {a.menge && <span className="text-xs text-zinc-400">{a.menge} {a.einheit ?? ''}</span>}
                </div>
              </div>
              <div className="tabular shrink-0 font-semibold">{eur(a.preis)}</div>
            </Card>
          ))}
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 px-3 py-2 text-sm text-zinc-500 hover:border-emerald-400 hover:text-emerald-600 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-emerald-500 dark:hover:text-emerald-400"
          >
            <Plus size={16} /> {t('receiptDetail.addArticle')}
          </button>
        </div>
      </div>

      <AddArticleModal
        einkaufId={data.id}
        open={adding}
        onClose={() => setAdding(false)}
        invalidateKeys={[['receipt', id], ['receipts']]}
      />

      <ArticleEditModal
        artikel={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
        invalidateKeys={[['receipt', id], ['receipts']]}
      />
    </div>
  );
}

function ReceiptEditModal({ receipt, open, onClose }: { receipt: ReceiptDetail; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [datum, setDatum] = useState((receipt.datum ?? '').slice(0, 10));
  const [laden, setLaden] = useState(receipt.roh_ladenname ?? '');
  const [gesamt, setGesamt] = useState(receipt.gesamt_betrag !== null ? String(receipt.gesamt_betrag) : '');

  useEffect(() => {
    if (open) {
      setDatum((receipt.datum ?? '').slice(0, 10));
      setLaden(receipt.roh_ladenname ?? '');
      setGesamt(receipt.gesamt_betrag !== null ? String(receipt.gesamt_betrag) : '');
    }
  }, [open, receipt]);

  const save = useMutation({
    mutationFn: () => api(`/api/receipts/${receipt.id}`, {
      method: 'PATCH',
      body: { datum, roh_ladenname: laden, gesamt_betrag: gesamt || null },
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['receipt', String(receipt.id)] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      void qc.invalidateQueries({ queryKey: ['stores'] });
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={t('receiptEdit.title')}>
      <div className="flex flex-col gap-4">
        <div>
          <Label>{t('receiptEdit.date')}</Label>
          <Input type="date" value={datum} onChange={e => setDatum(e.target.value)} />
        </div>
        <div>
          <Label>{t('receiptEdit.store')}</Label>
          <Input value={laden} onChange={e => setLaden(e.target.value)} />
        </div>
        <div>
          <Label>{t('receiptEdit.total')} (€)</Label>
          <Input inputMode="decimal" value={gesamt} onChange={e => setGesamt(e.target.value)} />
        </div>
        {save.isError && <p className="text-sm text-red-500">{(save.error as Error).message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={!datum || save.isPending}>{t('common.save')}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Pan + zoom (wheel / pinch / drag) in a fixed-size container so the
 *  surrounding layout (items list, sticky positioning) stays untouched. */
function ZoomableReceiptImage({ src }: { src: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
      <TransformWrapper
        initialScale={1}
        minScale={1}
        maxScale={6}
        wheel={{ step: 0.15 }}
        doubleClick={{ mode: 'reset' }}
        panning={{ velocityDisabled: true }}
      >
        <ZoomResetButton />
        <TransformComponent
          wrapperClass="!w-full"
          contentClass="!w-full"
        >
          <img src={src} alt="Beleg" draggable={false} className="block w-full select-none" />
        </TransformComponent>
      </TransformWrapper>
    </div>
  );
}

function ZoomResetButton() {
  const { resetTransform } = useControls();
  return (
    <button
      type="button"
      onClick={() => resetTransform()}
      className="absolute right-2 top-2 z-10 rounded-lg bg-black/40 px-2 py-1 text-xs font-medium text-white backdrop-blur transition hover:bg-black/60"
      title="Zoom zurücksetzen (Doppelklick / -tap)"
    >
      1:1
    </button>
  );
}
