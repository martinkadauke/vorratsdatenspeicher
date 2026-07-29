import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Camera, ImagePlus, Banknote, CreditCard, Lock, FileText } from 'lucide-react';
import { api } from '../api/client';
import { Modal, Button, Input, Label, Select } from './ui';
import { toast } from './Toast';
import { cn, fileToResizedDataUrl, fileToDataUrl } from '../lib/utils';
import { useAuth } from '../context/auth';

/** Bundled example receipt for the demo's first-run scan (frontend/public/demo-receipts). */
const SAMPLE_RECEIPT = '/demo-receipts/demo-6-erstscan-aldi.jpg';

interface StoreRow { display: string; raw: string[]; filialen?: { name: string }[] }
interface Konto { id: number; name: string; is_shared: boolean; is_cash: boolean }

/** Quick manual purchase entry (cash or card) with an optional photo. Nothing
 *  is required; if a photo is added it's OCR'd in the background server-side.
 *
 *  Demo build only: the bundled example receipt is pre-loaded so the first scan is a single
 *  tap — the user presses Speichern and watches the real OCR fill in the items, instead of
 *  having to find a receipt photo on their phone before seeing anything work.
 *  `sample` FORCES that preload (the tour CTA); without it the rule below decides. */
export function CreatePurchaseModal({ open, sample = false, onClose }: { open: boolean; sample?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { demo, user, refreshUser } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const today = () => new Date().toISOString().slice(0, 10);

  const { data: stores } = useQuery({ queryKey: ['stores'], queryFn: () => api<StoreRow[]>('/api/stores'), enabled: open });
  const { data: konten } = useQuery({ queryKey: ['konten'], queryFn: () => api<Konto[]>('/api/konten'), enabled: open });
  const storeNames = useMemo(() => {
    const set = new Set<string>();
    for (const s of stores ?? []) {
      (s.filialen ?? []).forEach(f => set.add(f.name));
      s.raw?.forEach(r => set.add(r));
      if (s.display) set.add(s.display);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [stores]);

  const [quelle, setQuelle] = useState<'zettel' | 'bar'>('zettel');
  const [laden, setLaden] = useState('');
  const [datum, setDatum] = useState(today);
  const [betrag, setBetrag] = useState('');
  const [kontoId, setKontoId] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoMime, setPhotoMime] = useState('image/jpeg');
  const [photoName, setPhotoName] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);

  // Accounts eligible for the chosen method: cash accounts for Barzahlung, the
  // regular ones for card. Falls back to all accounts if a set is empty.
  const kontenForMethod = useMemo(() => {
    const all = konten ?? [];
    const filtered = all.filter(k => (quelle === 'bar' ? k.is_cash : !k.is_cash));
    return filtered.length ? filtered : all;
  }, [konten, quelle]);

  // Default/repair the selected account whenever the method changes: cash → first
  // cash account; card → the shared account (GKK).
  useEffect(() => {
    if (!open || !kontenForMethod.length) return;
    if (kontenForMethod.some(k => String(k.id) === kontoId)) return; // still valid
    const fallback = quelle === 'bar'
      ? kontenForMethod[0]
      : (kontenForMethod.find(k => k.is_shared) ?? kontenForMethod[0]);
    setKontoId(String(fallback.id));
  }, [open, kontenForMethod, quelle, kontoId]);

  // WHICH openings preload the example receipt: every one of them — the tour CTA and the "+"
  // FAB alike — until this household has scanned a receipt of its own. Deciding here instead
  // of at the call sites is the point: a user who skips or dismisses the tour reaches the
  // scanner through the FAB, and that door used to open an empty dialogue, so the example was
  // never seen. After the first real scan demo_scanned flips and openings are empty as normal.
  const preloadSample = demo && (sample || !user?.demo_scanned);

  // Demo first-run: fetch the bundled receipt and drop it in as if the user had picked it,
  // so "Speichern" is the only step left. Silently does nothing if the fetch fails — the
  // dialog then behaves exactly like the normal one.
  //
  // The deps deliberately exclude photo/photoBusy: this effect WRITES photoBusy, so
  // depending on it made the effect re-run, which ran the previous cleanup (cancelled = true)
  // while the fetch was still in flight — the photo never landed and photoBusy stuck on,
  // disabling Speichern forever. A ref latch replaces the state read for "already ran".
  // For the same reason the dep is the derived BOOLEAN and not the `user` object: an unrelated
  // auth refresh (has_seen_tour, theme, …) hands back a new object but the same decision.
  const sampleTried = useRef(false);
  useEffect(() => {
    if (!open || !preloadSample || sampleTried.current) return;
    sampleTried.current = true;
    let cancelled = false;
    setPhotoBusy(true);
    void (async () => {
      try {
        const res = await fetch(SAMPLE_RECEIPT);
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(new Error('read failed'));
          fr.readAsDataURL(blob);
        });
        if (cancelled) return;
        setPhoto(dataUrl);
        setPhotoMime('image/jpeg');
        setPhotoName(t('createPurchase.sampleName'));
      } catch { /* leave the dialog empty — user can still pick their own */ }
      // Unconditional: a stale fetch must still release the button, or the dialog stays
      // stuck on "Verarbeite …" for the rest of the session (the modal never unmounts).
      finally { setPhotoBusy(false); }
    })();
    return () => { cancelled = true; };
  }, [open, preloadSample, t]);

  const reset = () => {
    setQuelle('zettel'); setLaden(''); setDatum(today()); setBetrag('');
    setKontoId(''); setPhoto(null); setPhotoMime('image/jpeg'); setPhotoName('');
    setPhotoBusy(false); setIsPrivate(false);
    sampleTried.current = false;   // a replayed tour may preload again
  };
  const close = () => { reset(); onClose(); };

  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/api/receipts', {
      method: 'POST',
      body: {
        quelle, roh_ladenname: laden, datum, gesamt_betrag: betrag,
        konto_id: kontoId ? parseInt(kontoId, 10) : null,
        private: isPrivate,
        photo_base64: photo ?? undefined, photo_mime: photo ? photoMime : undefined,
      },
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      void qc.invalidateQueries({ queryKey: ['receipt-quellen'] });
      void qc.invalidateQueries({ queryKey: ['review-progress'] });
      void qc.invalidateQueries({ queryKey: ['stores'] });
      toast(photo ? t('createPurchase.createdOcr') : t('createPurchase.created'), 'success');
      reset(); onClose();
      // Demo: a photo means the server just claimed an OCR run, so household.ocr_count left 0.
      // Pull the fresh auth user right away — otherwise demo_scanned stays stale until the next
      // reload and the example receipt would be preloaded again over the user's own scan.
      // (`photo` is this render's value; reset() above only schedules the state change.)
      if (demo && photo) void refreshUser();
      navigate(`/receipts/${r.id}`); // shows the photo immediately; items fill in via OCR
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setPhotoBusy(true);
    try {
      // Invoices from a portal / file share are often PDFs — keep those as-is (the same
      // Vision OCR handles PDF + image); only resize actual images.
      const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      setPhoto(isPdf ? await fileToDataUrl(f) : await fileToResizedDataUrl(f));
      setPhotoMime(isPdf ? 'application/pdf' : 'image/jpeg');
      setPhotoName(f.name);
    } catch { toast(t('createPurchase.photoError'), 'error'); }
    finally { setPhotoBusy(false); }
  };

  const methodBtn = (v: 'zettel' | 'bar', icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => setQuelle(v)}
      className={cn(
        'flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium',
        quelle === v
          ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
          : 'border-zinc-300 text-zinc-500 dark:border-zinc-700',
      )}
    >
      {icon} {label}
    </button>
  );

  const photoBtn = (icon: React.ReactNode, label: string, capture: boolean) => (
    <label className="flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 px-3 py-2.5 text-sm font-medium text-zinc-500 hover:border-emerald-400 hover:text-emerald-600 dark:border-zinc-700">
      {icon} {label}
      {/* Gallery/file button allows PDFs + images so Android opens the DOCUMENT picker
          (browse Downloads / SMB shares), not just the photo picker. Camera stays image-only. */}
      <input
        type="file" accept={capture ? 'image/*' : '.pdf,image/*'} className="hidden" onChange={onPhoto}
        {...(capture ? { capture: 'environment' as const } : {})}
      />
    </label>
  );

  return (
    <Modal open={open} onClose={close} title={t('createPurchase.title')}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          {methodBtn('zettel', <CreditCard size={16} />, t('createPurchase.card'))}
          {methodBtn('bar', <Banknote size={16} />, t('createPurchase.cash'))}
        </div>

        <div>
          <Label>{t('createPurchase.store')}</Label>
          <Input value={laden} list="vds-store-suggestions" onChange={e => setLaden(e.target.value)} placeholder={t('createPurchase.storePlaceholder')} />
          <datalist id="vds-store-suggestions">
            {storeNames.map(n => <option key={n} value={n} />)}
          </datalist>
        </div>

        {kontenForMethod.length > 0 && (
          <div>
            <Label>{quelle === 'bar' ? t('createPurchase.kontoCash') : t('createPurchase.konto')}</Label>
            <Select value={kontoId} onChange={e => setKontoId(e.target.value)}>
              {kontenForMethod.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
            </Select>
          </div>
        )}

        <label className="flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2.5 text-sm dark:border-zinc-700">
          <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} className="h-4 w-4 accent-emerald-600" />
          <Lock size={14} className="text-zinc-400" />
          <span>{t('createPurchase.private')}</span>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>{t('createPurchase.date')}</Label>
            <Input type="date" value={datum} onChange={e => setDatum(e.target.value)} />
          </div>
          <div>
            <Label>{t('createPurchase.amount')}</Label>
            <Input inputMode="decimal" value={betrag} onChange={e => setBetrag(e.target.value)} placeholder="0,00" />
          </div>
        </div>

        <div>
          <Label>{t('createPurchase.photo')}</Label>
          {photo ? (
            photoMime === 'application/pdf' ? (
              <div className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2.5 text-sm dark:border-zinc-800">
                <FileText size={18} className="shrink-0 text-rose-500" />
                <span className="min-w-0 truncate">{photoName || 'PDF'}</span>
              </div>
            ) : (
              <img src={photo} alt="" className="max-h-44 rounded-lg border border-zinc-200 dark:border-zinc-800" />
            )
          ) : (
            <div className="flex gap-2">
              {photoBtn(<Camera size={16} />, t('createPurchase.photoCamera'), true)}
              {photoBtn(<ImagePlus size={16} />, t('createPurchase.photoPick'), false)}
            </div>
          )}
          {photo && (
            <button type="button" onClick={() => setPhoto(null)} className="mt-1 text-xs text-zinc-400 hover:text-red-500">
              {t('createPurchase.photoRemove')}
            </button>
          )}
          {photoBusy && <p className="mt-1 text-xs text-zinc-400">{t('createPurchase.photoBusy')}</p>}
        </div>

        <p className="text-xs text-zinc-400">{photo ? t('createPurchase.ocrHint') : t('createPurchase.cameraRollHint')}</p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} disabled={create.isPending}>{t('common.cancel')}</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || photoBusy}>
            {create.isPending ? t('common.saving') : t('createPurchase.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
