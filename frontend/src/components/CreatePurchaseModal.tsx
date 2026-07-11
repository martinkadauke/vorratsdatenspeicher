import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Camera, ImagePlus, Banknote, CreditCard, Lock, FileText } from 'lucide-react';
import { api } from '../api/client';
import { Modal, Button, Input, Label, Select } from './ui';
import { toast } from './Toast';
import { cn, fileToResizedDataUrl, fileToDataUrl } from '../lib/utils';

interface StoreRow { display: string; raw: string[]; filialen?: { name: string }[] }
interface Konto { id: number; name: string; is_shared: boolean; is_cash: boolean }

/** Quick manual purchase entry (cash or card) with an optional photo. Nothing
 *  is required; if a photo is added it's OCR'd in the background server-side. */
export function CreatePurchaseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
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

  const reset = () => {
    setQuelle('zettel'); setLaden(''); setDatum(today()); setBetrag('');
    setKontoId(''); setPhoto(null); setPhotoMime('image/jpeg'); setPhotoName(''); setIsPrivate(false);
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
