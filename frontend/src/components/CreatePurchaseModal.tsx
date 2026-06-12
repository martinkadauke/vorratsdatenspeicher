import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Camera, Banknote, CreditCard } from 'lucide-react';
import { api } from '../api/client';
import { Modal, Button, Input, Label } from './ui';
import { toast } from './Toast';
import { cn, fileToResizedDataUrl } from '../lib/utils';

/** Quick manual purchase entry (cash or card) with an optional photo. Nothing
 *  is required — the point is to capture *something* fast; details later. */
export function CreatePurchaseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const today = () => new Date().toISOString().slice(0, 10);

  const [quelle, setQuelle] = useState<'zettel' | 'bar'>('zettel'); // card → zettel, cash → bar
  const [laden, setLaden] = useState('');
  const [datum, setDatum] = useState(today);
  const [betrag, setBetrag] = useState('');
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  const reset = () => { setQuelle('zettel'); setLaden(''); setDatum(today()); setBetrag(''); setPhoto(null); };
  const close = () => { reset(); onClose(); };

  const create = useMutation({
    mutationFn: () => api<{ id: number }>('/api/receipts', {
      method: 'POST',
      body: {
        quelle, roh_ladenname: laden, datum, gesamt_betrag: betrag,
        photo_base64: photo ?? undefined, photo_mime: photo ? 'image/jpeg' : undefined,
      },
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      void qc.invalidateQueries({ queryKey: ['receipt-quellen'] });
      void qc.invalidateQueries({ queryKey: ['review-progress'] });
      void qc.invalidateQueries({ queryKey: ['stores'] });
      toast(t('createPurchase.created'), 'success');
      reset(); onClose();
      navigate(`/receipts/${r.id}`); // land on it so details can be filled in
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
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

  return (
    <Modal open={open} onClose={close} title={t('createPurchase.title')}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          {methodBtn('zettel', <CreditCard size={16} />, t('createPurchase.card'))}
          {methodBtn('bar', <Banknote size={16} />, t('createPurchase.cash'))}
        </div>

        <div>
          <Label>{t('createPurchase.store')}</Label>
          <Input value={laden} onChange={e => setLaden(e.target.value)} placeholder={t('createPurchase.storePlaceholder')} />
        </div>

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
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 px-3 py-2.5 text-sm font-medium text-zinc-500 hover:border-emerald-400 hover:text-emerald-600 dark:border-zinc-700">
            <Camera size={16} /> {photoBusy ? t('createPurchase.photoBusy') : photo ? t('createPurchase.photoChange') : t('createPurchase.photoAdd')}
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPhoto} />
          </label>
          {photo && <img src={photo} alt="" className="mt-2 max-h-44 rounded-lg border border-zinc-200 dark:border-zinc-800" />}
        </div>

        <p className="text-xs text-zinc-400">{t('createPurchase.hint')}</p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || photoBusy}>
            {create.isPending ? t('common.saving') : t('createPurchase.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
