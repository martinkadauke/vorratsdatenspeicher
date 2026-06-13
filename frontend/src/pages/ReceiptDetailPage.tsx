import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Pencil, Trash2, AlertTriangle, ScanLine, Plus, ChevronLeft, ChevronRight, RotateCw, CheckCircle2, Circle, Hand, Wallet, X, Search, Ban } from 'lucide-react';
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch';
import { api } from '../api/client';
import type { Artikel, Receipt, ReceiptDetail } from '../api/types';
import { Spinner, Modal, Input, Label, Button, ProgressBar, Select } from '../components/ui';
import { ArticleEditModal } from '../components/ArticleEditModal';
import { AddArticleModal } from '../components/AddArticleModal';
import { SortableArticleList } from '../components/SortableArticleList';
import { toast } from '../components/Toast';
import { confirm } from '../components/Confirm';
import { eur, fmtDate } from '../lib/utils';
import { searchMatch } from '../lib/search';

export function ReceiptDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  // Filter context (?store=&q=) carried from the list so prev/next stay
  // within the filtered set.
  const filterQs = location.search;
  const [editing, setEditing] = useState<Artikel | null>(null);
  const [editReceipt, setEditReceipt] = useState(false);
  const [adding, setAdding] = useState(false);
  const [imgVersion, setImgVersion] = useState(0); // cache-buster after rotate
  const [panEnabled, setPanEnabled] = useState(false); // mobile: image pan active?

  // Item highlight: from URL (?highlight=<artikelId> or ?hq=<text>) or the
  // in-view search box. Used to spotlight items when arriving from the queue,
  // a canonical name, or a search.
  const params = new URLSearchParams(location.search);
  const highlightId = params.get('highlight') ? parseInt(params.get('highlight')!, 10) : null;
  // Highlight term: explicit ?hq=, else the list search ?q= (so coming from a
  // receipts search highlights matching items; store-name-only matches won't
  // highlight because matchIds only checks item fields).
  const [itemSearch, setItemSearch] = useState(params.get('hq') ?? params.get('q') ?? '');
  const searchRef = useRef<HTMLInputElement>(null);

  const deleteReceipt = useMutation({
    mutationFn: () => api(`/api/receipts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      const delId = Number(id);
      // Optimistically drop it from every cached receipts list so it can't
      // flash back in before the refetch lands.
      qc.setQueriesData<Receipt[][] | { pages: Receipt[][] } | undefined>({ queryKey: ['receipts'] }, (old) => {
        if (!old || !('pages' in old)) return old;
        return { ...old, pages: old.pages.map(p => p.filter(r => r.id !== delId)) };
      });
      qc.removeQueries({ queryKey: ['receipt', id] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      void qc.invalidateQueries({ queryKey: ['stores'] });
      void qc.invalidateQueries({ queryKey: ['review-progress'] });
      navigate('/receipts');
    },
  });

  const rotate = useMutation({
    mutationFn: () => api(`/api/receipts/${id}/rotate`, { method: 'POST' }),
    onSuccess: () => setImgVersion(v => v + 1),
    onError: (err: Error) => toast(`${t('receiptDetail.rotateFailed')}: ${err.message}`, 'error'),
  });

  const reocr = useMutation({
    mutationFn: () => api<{ items: number; confidence: number }>(`/api/receipts/${id}/reocr`, { method: 'POST' }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['receipt', id] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      toast(t('receiptDetail.reocrDone', { count: res.items, confidence: Math.round(res.confidence * 100) }), 'success');
    },
    onError: (err: Error) => toast(`${t('receiptDetail.reocrFailed')}: ${err.message}`, 'error'),
  });

  const setReviewed = useMutation({
    mutationFn: (value: boolean) => api(`/api/receipts/${id}`, { method: 'PATCH', body: { geprueft: value } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['receipt', id] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      void qc.invalidateQueries({ queryKey: ['review-progress'] });
    },
  });

  const mountedAt = useRef(Date.now());
  const { data, isLoading } = useQuery({
    queryKey: ['receipt', id],
    queryFn: () => api<ReceiptDetail>(`/api/receipts/${id}`),
    enabled: !!id,
    // a fresh upload OCRs in the background — poll briefly until items appear
    refetchInterval: (q) => {
      const d = q.state.data as ReceiptDetail | undefined;
      const pending = !!d?.bild_pfad && d.artikel.length === 0;
      return pending && Date.now() - mountedAt.current < 150_000 ? 4000 : false;
    },
  });
  const { data: avoidedList } = useQuery({
    queryKey: ['avoided'],
    queryFn: () => api<string[]>('/api/avoided'),
    staleTime: 60_000,
  });

  // Celebrate the moment the item sum first matches the receipt total.
  const wasMatched = useRef(false);
  const [matchFlash, setMatchFlash] = useState(false);
  useEffect(() => {
    if (!data) return;
    const sum = data.artikel.reduce((acc, a) => {
      const p = parseFloat((a.preis ?? '').toString().replace(',', '.'));
      return acc + (Number.isFinite(p) ? p : 0);
    }, 0);
    const total = parseFloat((data.gesamt_betrag ?? '').toString().replace(',', '.'));
    const matched = Number.isFinite(total) && Math.abs(sum - total) <= 0.01;
    if (matched && !wasMatched.current) {
      setMatchFlash(true);
      const t = setTimeout(() => setMatchFlash(false), 1000);
      wasMatched.current = matched;
      return () => clearTimeout(t);
    }
    wasMatched.current = matched;
  }, [data]);

  const { data: neighbors } = useQuery({
    queryKey: ['receipt-neighbors', id, filterQs],
    queryFn: () => api<{ prev_id: number | null; next_id: number | null }>(
      `/api/receipts/${id}/neighbors${filterQs}`,
    ),
    enabled: !!id,
  });

  const goPrev = () => neighbors?.prev_id && navigate(`/receipts/${neighbors.prev_id}${filterQs}`);
  const goNext = () => neighbors?.next_id && navigate(`/receipts/${neighbors.next_id}${filterQs}`);

  // Keyboard: ← / → navigate, E opens the receipt edit window. Ignored while
  // typing in a field or a modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || editReceipt || adding) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      if (e.key === 'e' || e.key === 'E') { e.preventDefault(); setEditReceipt(true); }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neighbors, editing, editReceipt, adding]);

  // Touch: horizontal swipe (>60px, mostly horizontal) navigates — but not
  // when the gesture starts on the zoomable image (would fight panning).
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (editing || editReceipt || adding) return;
    // Only block swipe over the image when panning is ACTIVE (would fight the
    // drag). With pan off, swiping anywhere — including over the image —
    // navigates to the prev/next receipt.
    if (panEnabled && (e.target as HTMLElement).closest('[data-zoom-container]')) { touchStart.current = null; return; }
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

  // Which line items to spotlight. Supports the shared search operators
  // (foo bar = AND, "foo, bar" = OR, -foo = exclude, "phrase", accent-insensitive).
  const q = itemSearch.trim();
  const matchIds = new Set<number>();
  if (highlightId) matchIds.add(highlightId);
  if (q) {
    for (const a of data.artikel) {
      if (searchMatch(q, [a.canonical_name, a.ai_guess, a.name, a.original_text])) matchIds.add(a.id);
    }
  }
  const scrollToId = highlightId ?? (q ? [...matchIds][0] ?? null : null);

  // A freshly uploaded photo is being OCR'd server-side (no items yet).
  const ocrPending = !!data.bild_pfad && data.artikel.length === 0 && Date.now() - mountedAt.current < 150_000;

  // Warn if this receipt contains items the household decided to avoid.
  const avoidedSet = new Set(avoidedList ?? []);
  const avoidedHere = [...new Set(
    data.artikel.map(a => a.canonical_name).filter((c): c is string => !!c && avoidedSet.has(c)),
  )];

  return (
    <div className="flex flex-col gap-4" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      {matchFlash && <div className="flash-green-overlay pointer-events-none fixed inset-0 z-50 bg-emerald-400/30" />}
      <div className="flex items-center gap-2 sm:gap-3">
        <Link to={`/receipts${filterQs}`} className="shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
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
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {data.konto_name && (
              <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                <Wallet size={11} /> {data.konto_name}
              </span>
            )}
            {data.quelle && (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {t(`quelle.${data.quelle}`)}
              </span>
            )}
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
          onClick={async () => { if (await confirm({ title: t('receiptDetail.reocr'), message: t('receiptDetail.reocrConfirm'), confirmLabel: t('receiptDetail.reocr'), cancelLabel: t('common.cancel') })) reocr.mutate(); }}
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
          onClick={async () => { if (await confirm({ title: t('receiptEdit.delete'), message: t('receiptEdit.deleteConfirm'), confirmLabel: t('common.delete'), cancelLabel: t('common.cancel'), danger: true })) deleteReceipt.mutate(); }}
          disabled={deleteReceipt.isPending}
          className="shrink-0 rounded-xl p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
          title={t('receiptEdit.delete')}
        >
          <Trash2 size={18} />
        </button>
      </div>

      {reocr.isPending && (
        <ProgressBar label={t('receiptDetail.reocrRunning')} />
      )}

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

      {ocrPending && (
        <div className="flex items-center gap-2 rounded-xl border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-800 dark:border-sky-700/50 dark:bg-sky-950/40 dark:text-sky-300">
          <ScanLine size={16} className="shrink-0 animate-pulse" />
          <span>{t('receiptDetail.ocrPending')}</span>
        </div>
      )}

      {avoidedHere.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700/50 dark:bg-red-950/40 dark:text-red-300">
          <Ban size={16} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <span className="font-medium">{t('receiptDetail.avoidedWarning')}: </span>
            <span>{avoidedHere.join(', ')}</span>
          </div>
        </div>
      )}

      <button
        onClick={() => setReviewed.mutate(!data.geprueft)}
        disabled={setReviewed.isPending}
        className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm font-medium transition ${
          data.geprueft
            ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/40 dark:text-emerald-300'
            : 'border-zinc-300 bg-white text-zinc-600 hover:border-emerald-300 hover:bg-emerald-50/50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-emerald-700/50'
        }`}
      >
        {data.geprueft
          ? <CheckCircle2 size={20} className="shrink-0 text-emerald-600 dark:text-emerald-500" />
          : <Circle size={20} className="shrink-0 text-zinc-400" />}
        <span>{data.geprueft ? t('receiptDetail.reviewedYes') : t('receiptDetail.reviewedNo')}</span>
      </button>

      <ReceiptEditModal receipt={data} open={editReceipt} onClose={() => setEditReceipt(false)} />

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* Receipt image — zoomable in place so items list stays visible */}
        <div className="lg:sticky lg:top-[60px] lg:self-start">
          {data.bild_pfad ? (
            <ZoomableReceiptImage
              src={imgVersion ? `${data.bild_pfad}?v=${imgVersion}` : data.bild_pfad}
              panEnabled={panEnabled}
              onPanToggle={() => setPanEnabled(v => !v)}
            />
          ) : (
            <div className="flex h-48 items-center justify-center rounded-2xl bg-zinc-100 text-sm text-zinc-400 dark:bg-zinc-900">
              {t('receipts.noImage')}
            </div>
          )}
        </div>

        {/* Line items — drag the grip handle to reorder */}
        <div className="flex min-w-0 flex-col gap-1.5">
          {data.artikel.length > 1 && (
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <Input
                ref={searchRef}
                className="pl-9 pr-9"
                placeholder={t('receiptDetail.searchItems')}
                value={itemSearch}
                onChange={e => setItemSearch(e.target.value)}
              />
              {itemSearch && (
                <button onClick={() => setItemSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
                  <X size={15} />
                </button>
              )}
            </div>
          )}
          <SortableArticleList
            receiptId={data.id}
            artikel={data.artikel}
            onEdit={setEditing}
            highlightIds={matchIds}
            scrollToId={scrollToId}
            keyboardNav={!editing && !adding && !editReceipt}
          />
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
  const [kontoId, setKontoId] = useState<number | ''>(receipt.konto_id ?? '');
  const [quelle, setQuelle] = useState(receipt.quelle ?? 'zettel');

  const { data: konten } = useQuery({
    queryKey: ['konten'],
    queryFn: () => api<{ id: number; name: string }[]>('/api/konten'),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setDatum((receipt.datum ?? '').slice(0, 10));
      setLaden(receipt.roh_ladenname ?? '');
      setGesamt(receipt.gesamt_betrag !== null ? String(receipt.gesamt_betrag) : '');
      setKontoId(receipt.konto_id ?? '');
      setQuelle(receipt.quelle ?? 'zettel');
    }
  }, [open, receipt]);

  const save = useMutation({
    mutationFn: () => api(`/api/receipts/${receipt.id}`, {
      method: 'PATCH',
      body: { datum, roh_ladenname: laden, gesamt_betrag: gesamt || null, konto_id: kontoId || null, quelle },
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['receipt', String(receipt.id)] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      void qc.invalidateQueries({ queryKey: ['stores'] });
      void qc.invalidateQueries({ queryKey: ['review-progress'] });
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={t('receiptEdit.title')}>
      <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); if (datum && !save.isPending) save.mutate(); }}>
        <div>
          <Label>{t('receiptEdit.date')}</Label>
          <Input autoFocus type="date" value={datum} onChange={e => setDatum(e.target.value)} />
        </div>
        <div>
          <Label>{t('receiptEdit.store')}</Label>
          <Input value={laden} onChange={e => setLaden(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t('receiptEdit.total')} (€)</Label>
            <Input inputMode="decimal" value={gesamt} onChange={e => setGesamt(e.target.value)} />
          </div>
          <div>
            <Label>{t('receiptEdit.quelle')}</Label>
            <Select value={quelle} onChange={e => setQuelle(e.target.value)}>
              <option value="zettel">{t('quelle.zettel')}</option>
              <option value="bar">{t('quelle.bar')}</option>
              <option value="email">{t('quelle.email')}</option>
            </Select>
          </div>
        </div>
        <div>
          <Label>{t('receiptEdit.konto')}</Label>
          <Select value={kontoId} onChange={e => setKontoId(e.target.value ? parseInt(e.target.value, 10) : '')}>
            {konten?.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
          </Select>
        </div>
        {save.isError && <p className="text-sm text-red-500">{(save.error as Error).message}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!datum || save.isPending}>{t('common.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Pan + zoom in a fixed-size container so the surrounding layout stays
 *  untouched. On touch devices, single-finger panning is OFF by default so
 *  the page scrolls freely when you drag over the image; tap the hand
 *  button to activate panning. Pinch-to-zoom always works. On desktop the
 *  mouse drag pans normally. */
function ZoomableReceiptImage({ src, panEnabled, onPanToggle }: { src: string; panEnabled: boolean; onPanToggle: () => void }) {
  const { t } = useTranslation();
  const [isTouch] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches);
  const panningDisabled = isTouch && !panEnabled;

  return (
    <div data-zoom-container className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
      <TransformWrapper
        initialScale={1}
        minScale={1}
        maxScale={6}
        wheel={{ step: 0.15 }}
        doubleClick={{ mode: 'reset' }}
        panning={{ velocityDisabled: true, disabled: panningDisabled }}
      >
        <ZoomResetButton />
        {isTouch && (
          <button
            type="button"
            onClick={onPanToggle}
            className={`absolute bottom-2 right-2 z-10 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium backdrop-blur transition ${
              panEnabled
                ? 'bg-emerald-600 text-white'
                : 'bg-black/40 text-white hover:bg-black/60'
            }`}
          >
            <Hand size={13} />
            {panEnabled ? t('receiptDetail.panOn') : t('receiptDetail.panOff')}
          </button>
        )}
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
