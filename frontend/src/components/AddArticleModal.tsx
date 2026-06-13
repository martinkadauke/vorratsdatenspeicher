import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { Button, Input, Label, Modal } from './ui';
import { CategoryPicker } from './CategoryPicker';

interface NameOption { canonical_name: string }

const num = (s: string): number | null => {
  const n = parseFloat((s ?? '').toString().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const fmt = (n: number): string => n.toFixed(2).replace('.', ',');

/** Lightweight modal for adding a new artikel to an existing einkauf.
 *  Reuses the unit-price / total-price auto-calc UX from ArticleEditModal
 *  but skips the cascade-apply / consumers complexity. */
export function AddArticleModal({ einkaufId, open, onClose, invalidateKeys, afterArtikelId }: {
  einkaufId: number;
  open: boolean;
  onClose: () => void;
  invalidateKeys: unknown[][];
  /** When set, the new item is inserted directly under this artikel (else appended). */
  afterArtikelId?: number | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [canonical, setCanonical] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [menge, setMenge] = useState('1');
  const [einheit, setEinheit] = useState('stk');
  const [einzelPreis, setEinzelPreis] = useState('');
  const [preis, setPreis] = useState('');
  const [nameOptions, setNameOptions] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setCanonical('');
    setCategory(null);
    setMenge('1');
    setEinheit('stk');
    setEinzelPreis('');
    setPreis('');
    api<NameOption[]>('/api/names').then(rows => setNameOptions(rows.map(r => r.canonical_name))).catch(() => {});
  }, [open]);

  const onMengeChange = (v: string) => {
    setMenge(v);
    const m = num(v), p = num(einzelPreis);
    if (m !== null && p !== null) setPreis(fmt(m * p));
  };
  const onEinzelChange = (v: string) => {
    setEinzelPreis(v);
    const m = num(menge), p = num(v);
    if (m !== null && p !== null) setPreis(fmt(m * p));
  };
  const onPreisChange = (v: string) => {
    setPreis(v);
    const m = num(menge), t = num(v);
    if (m !== null && t !== null && m !== 0) setEinzelPreis(fmt(t / m));
  };

  const save = useMutation({
    mutationFn: () => api('/api/articles', {
      method: 'POST',
      body: {
        einkauf_id: einkaufId,
        after_artikel_id: afterArtikelId ?? null,
        name: canonical,
        canonical_name: canonical || null,
        category_path: category,
        menge: menge || null,
        einheit: einheit || null,
        preis: preis || null,
      },
    }),
    onSuccess: () => {
      for (const key of invalidateKeys) void qc.invalidateQueries({ queryKey: key });
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={t('receiptDetail.addArticle')}>
      <div className="flex flex-col gap-4">
        <div>
          <Label>{t('article.canonical')}</Label>
          <Input list="canonical-names-add" value={canonical} onChange={e => setCanonical(e.target.value)} autoFocus />
          <datalist id="canonical-names-add">
            {nameOptions.map(n => <option key={n} value={n} />)}
          </datalist>
        </div>

        <div>
          <Label>{t('article.category')}</Label>
          <CategoryPicker value={category} onChange={setCategory} />
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div>
            <Label>{t('article.amount')}</Label>
            <Input inputMode="decimal" value={menge} onChange={e => onMengeChange(e.target.value)} />
          </div>
          <div>
            <Label>{t('article.unit')}</Label>
            <Input value={einheit} onChange={e => setEinheit(e.target.value)} />
          </div>
          <div>
            <Label>{t('article.unitPrice')} (€)</Label>
            <Input inputMode="decimal" value={einzelPreis} onChange={e => onEinzelChange(e.target.value)} />
          </div>
          <div>
            <Label>{t('article.totalPrice')} (€)</Label>
            <Input inputMode="decimal" value={preis} onChange={e => onPreisChange(e.target.value)} />
          </div>
        </div>

        {save.isError && <p className="text-sm text-red-500">{(save.error as Error).message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={!canonical || save.isPending}>{t('common.add')}</Button>
        </div>
      </div>
    </Modal>
  );
}
