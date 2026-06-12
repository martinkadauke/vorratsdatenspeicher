import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Camera, ImagePlus, Banknote, CreditCard } from 'lucide-react';
import { api } from '../api/client';
import { Modal, Button, Input, Label, Select } from './ui';
import { toast } from './Toast';
import { cn, fileToResizedDataUrl } from '../lib/utils';

interface StoreRow { display: string; raw: string[]; filialen?: { name: string }[] }
interface Konto { id: number; name: string; is_shared: boolean }

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
  const [photoBusy, setPhotoBusy] = useState(false);

  // default to the shared account (GKK) once accounts load
  useEffect(() => {
    if (open && !kontoId && konten?.length) {
      const shared = konten.find(k => k.is_shared) ?? konten[0];
      if (shared) setKontoId(String(shared.id));
    }
  }, [open, konten, kontoId]);

  const reset = () => {
    setQuelle('zettel'); setLaden(''); setDatum(today()); setBetrag('');
    setKontoId(''); setPhoto(null);
  };
  const close = () => { reset(); onClose(); };

  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/api/receipts', {
      method: 'POST',
      body: {
        quelle, roh_ladenname: laden, datum, gesamt_betrag: betrag,
        konto_id: kontoId ? parseInt(kontoId, 10) : null,
        photo_base64: photo ?? undefined, photo_mime: photo ? 'image/jpeg' : undefined,
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
    try { setPhoto(await fileToResizedDataUrl(f)); }
    catch { toast(t('createPurchase.photoError'), 'error'); }
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
      <input
        type="file" accept="image/*" className="hidden" onChange={onPhoto}
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

        {konten && konten.length > 0 && (
          <div>
            <Label>{t('createPurchase.konto')}</Label>
            <Select value={kontoId} onChange={e => setKontoId(e.target.value)}>
              {konten.map(k => <option key={k.id} value={k.id}>{k.name}</option>)}
            </Select>
          </div>
        )}

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
            <img src={photo} alt="" className="max-h-44 rounded-lg border border-zinc-200 dark:border-zinc-800" />
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
