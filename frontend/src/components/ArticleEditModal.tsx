import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { Artikel } from '../api/types';
import { Button, Input, Label, Modal } from './ui';
import { CategoryPicker } from './CategoryPicker';
import { ConsumerChips } from './ConsumerChips';

/** Parse "12", "1,5", "0.99" into number; null if not parseable. */
const num = (s: string): number | null => {
  const n = parseFloat((s ?? '').toString().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
/** Format a number with 2 decimal places, comma as separator. */
const fmt = (n: number): string => n.toFixed(2).replace('.', ',');
const multiply = (mengeStr: string, preisStr: string): string | null => {
  const m = num(mengeStr), p = num(preisStr);
  if (m === null || p === null) return null;
  return fmt(m * p);
};
const computeEinzel = (mengeStr: string, totalStr: string): string => {
  const m = num(mengeStr), t = num(totalStr);
  if (m === null || t === null || m === 0) return '';
  return fmt(t / m);
};

interface NameOption { canonical_name: string }

export function ArticleEditModal({ artikel, open, onClose, invalidateKeys }: {
  artikel: Artikel | null;
  open: boolean;
  onClose: () => void;
  invalidateKeys: unknown[][];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [canonical, setCanonical] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [menge, setMenge] = useState('');
  const [einheit, setEinheit] = useState('');
  const [preis, setPreis] = useState('');           // Gesamtpreis (line total, persisted)
  const [einzelPreis, setEinzelPreis] = useState(''); // Preis/Einheit (derived helper)
  const [consumers, setConsumers] = useState<number[]>([]);
  const [exclusive, setExclusive] = useState(false);
  const [applyAll, setApplyAll] = useState(true);
  const [nameOptions, setNameOptions] = useState<string[]>([]);

  useEffect(() => {
    if (!artikel) return;
    setCanonical(artikel.canonical_name ?? '');
    setCategory(artikel.category_path);
    const m = artikel.menge ?? '';
    const p = artikel.preis ?? '';
    setMenge(m);
    setEinheit(artikel.einheit ?? '');
    setPreis(p);
    setEinzelPreis(computeEinzel(m, p));
    setConsumers(artikel.consumers);
    setExclusive(artikel.consumers_exclusive);
    setApplyAll(true);
  }, [artikel]);

  // Editing menge: keep einzelPreis, recompute Gesamt
  const onMengeChange = (v: string) => {
    setMenge(v);
    const newTotal = multiply(v, einzelPreis);
    if (newTotal !== null) setPreis(newTotal);
  };
  // Editing einzelPreis: recompute Gesamt
  const onEinzelChange = (v: string) => {
    setEinzelPreis(v);
    const newTotal = multiply(menge, v);
    if (newTotal !== null) setPreis(newTotal);
  };
  // Editing Gesamt: recompute einzelPreis
  const onPreisChange = (v: string) => {
    setPreis(v);
    setEinzelPreis(computeEinzel(menge, v));
  };

  useEffect(() => {
    if (!open) return;
    api<NameOption[]>('/api/names').then(rows => setNameOptions(rows.map(r => r.canonical_name))).catch(() => {});
  }, [open]);

  const invalidate = () => {
    for (const key of invalidateKeys) void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['names'] });
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!artikel) return;
      const oldCanonical = artikel.canonical_name;

      // Per-artikel fields always patch this one row
      await api(`/api/articles/${artikel.id}`, {
        method: 'PATCH',
        body: {
          canonical_name: canonical || null,
          menge: menge === '' ? null : menge,
          einheit: einheit || null,
          preis: preis === '' ? null : preis,
          ...(applyAll ? {} : { category_path: category }),
        },
      });

      if (applyAll && canonical) {
        // Cascade category to every artikel sharing the (possibly new) canonical name
        await api(`/api/canonical/${encodeURIComponent(canonical)}`, {
          method: 'PUT',
          body: { category_path: category },
        });
        await api(`/api/canonical/${encodeURIComponent(canonical)}/consumers`, {
          method: 'PUT',
          body: { members: consumers, exclusive },
        });
      } else {
        await api(`/api/articles/${artikel.id}/consumers`, {
          method: 'PUT',
          body: { members: consumers },
        });
      }

      void oldCanonical;
    },
    onSuccess: () => { invalidate(); onClose(); },
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!artikel) return;
      await api(`/api/articles/${artikel.id}`, { method: 'DELETE' });
    },
    onSuccess: () => { invalidate(); onClose(); },
  });

  if (!artikel) return null;

  return (
    <Modal open={open} onClose={onClose} title={t('article.edit')}>
      <div className="flex flex-col gap-4">
        {artikel.original_text && (
          <div>
            <Label>{t('article.originalText')}</Label>
            <div className="rounded-xl bg-zinc-100 px-3 py-2 font-mono text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {artikel.original_text}
              {artikel.ai_guess && <div className="mt-1 text-zinc-400">KI: {artikel.ai_guess}</div>}
            </div>
          </div>
        )}

        <div>
          <Label>{t('article.canonical')}</Label>
          <Input list="canonical-names" value={canonical} onChange={e => setCanonical(e.target.value)} />
          <datalist id="canonical-names">
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

        <div>
          <Label>{t('article.consumers')}</Label>
          <ConsumerChips
            selected={consumers}
            onChange={setConsumers}
            exclusive={exclusive}
            onExclusiveChange={setExclusive}
          />
        </div>

        <div>
          <Label>{t('article.applyTo')}</Label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setApplyAll(false)}
              className={`flex-1 rounded-xl border px-3 py-2 text-sm ${!applyAll ? 'border-emerald-500 bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700'}`}
            >
              {t('article.applyOne')}
            </button>
            <button
              type="button"
              onClick={() => setApplyAll(true)}
              className={`flex-1 rounded-xl border px-3 py-2 text-sm ${applyAll ? 'border-emerald-500 bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'border-zinc-300 text-zinc-500 dark:border-zinc-700'}`}
            >
              {t('article.applyAll')}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <Button
            variant="danger"
            onClick={() => { if (confirm(t('article.deleteConfirm'))) remove.mutate(); }}
          >
            {t('article.delete')}
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>{t('article.cancel')}</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>{t('article.save')}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
