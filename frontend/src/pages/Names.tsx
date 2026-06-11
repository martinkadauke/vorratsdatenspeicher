import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Search, ReceiptText, Store } from 'lucide-react';
import { api } from '../api/client';
import type { CanonicalName, Receipt } from '../api/types';
import { Card, Input, Spinner, EmptyState, Badge, Modal, Button, Label } from '../components/ui';
import { CategoryPicker } from '../components/CategoryPicker';
import { ConsumerChips, ConsumerDots } from '../components/ConsumerChips';
import { fmtDate, eur } from '../lib/utils';

interface PriceHistory {
  canonical: string;
  stores: { key: string; display: string; avg_eur: number; points: unknown[] }[];
  cheapest: { key: string; display: string; avg_eur: number } | null;
}

export function Names() {
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<CanonicalName | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['names', search],
    queryFn: () => api<CanonicalName[]>(`/api/names?q=${encodeURIComponent(search)}`),
  });

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-bold">{t('names.title')}</h1>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
        <Input className="pl-9" placeholder={t('names.search')} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {isLoading && <Spinner />}
      {!isLoading && !data?.length && <EmptyState>–</EmptyState>}

      <div className="grid gap-1.5 sm:grid-cols-2">
        {data?.map(n => (
          <Card key={n.canonical_name} onClick={() => setSelected(n)} className="flex min-w-0 items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium">{n.canonical_name}</span>
                <ConsumerDots ids={n.consumers} />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-zinc-400">
                <Badge>{n.artikel_count}× </Badge>
                {n.category_path && <Badge className="truncate max-w-[60vw] sm:max-w-none">{n.category_path.split('/').pop()}</Badge>}
                {n.last_bought && <span>{t('names.lastBought')}: {fmtDate(n.last_bought, i18n.language)}</span>}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <NameEditModal name={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function NameEditModal({ name, onClose }: { name: CanonicalName | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [newName, setNewName] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [translation, setTranslation] = useState('');
  const [consumers, setConsumers] = useState<number[]>([]);
  const [exclusive, setExclusive] = useState(false);

  // Reset local form state whenever a different name is opened
  useEffect(() => {
    if (!name) return;
    setNewName(name.canonical_name);
    setCategory(name.category_path);
    setTranslation(name.translation_en ?? '');
    setConsumers(name.consumers);
    setExclusive(name.consumers_exclusive);
  }, [name?.canonical_name]);

  const { data: receipts } = useQuery({
    queryKey: ['name-receipts', name?.canonical_name],
    queryFn: () => api<Receipt[]>(`/api/canonical/${encodeURIComponent(name!.canonical_name)}/receipts`),
    enabled: !!name,
  });

  const { data: prices } = useQuery({
    queryKey: ['name-prices', name?.canonical_name],
    queryFn: () => api<PriceHistory>(`/api/stores/price-history?canonical=${encodeURIComponent(name!.canonical_name)}`),
    enabled: !!name,
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!name) return;
      const orig = name.canonical_name;
      await api(`/api/canonical/${encodeURIComponent(orig)}`, {
        method: 'PUT',
        body: {
          new_name: newName !== orig ? newName : undefined,
          category_path: category,
        },
      });
      const effective = newName || orig;
      await api(`/api/canonical/${encodeURIComponent(effective)}/consumers`, {
        method: 'PUT',
        body: { members: consumers, exclusive },
      });
      if (translation !== (name.translation_en ?? '')) {
        await api(`/api/canonical/${encodeURIComponent(effective)}/translation`, {
          method: 'PUT',
          body: { lang: 'en', translated: translation },
        });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['names'] });
      onClose();
    },
  });

  if (!name) return null;

  return (
    <Modal open={!!name} onClose={onClose} title={name.canonical_name}>
      <div className="flex flex-col gap-4">
        <div>
          <Label>{t('names.rename')}</Label>
          <Input value={newName} onChange={e => setNewName(e.target.value)} />
        </div>
        <div>
          <Label>{t('names.translation')}</Label>
          <Input value={translation} onChange={e => setTranslation(e.target.value)} placeholder="English name…" />
        </div>
        <div>
          <Label>{t('article.category')}</Label>
          <CategoryPicker value={category} onChange={setCategory} />
        </div>
        <div>
          <Label>{t('article.consumers')}</Label>
          <ConsumerChips selected={consumers} onChange={setConsumers} exclusive={exclusive} onExclusiveChange={setExclusive} />
        </div>

        {prices && prices.stores.length > 1 && (
          <div>
            <Label>{t('names.byStore')}</Label>
            <div className="flex flex-col gap-1">
              {prices.stores.sort((a, b) => a.avg_eur - b.avg_eur).map(s => {
                const isCheapest = prices.cheapest?.key === s.key;
                return (
                  <div
                    key={s.key}
                    className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-sm ${isCheapest
                      ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/40'
                      : 'border-zinc-200 dark:border-zinc-800'}`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Store size={13} className="text-zinc-400" />
                      {s.display}
                      {isCheapest && <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">{t('names.cheapest')}</Badge>}
                    </span>
                    <span className="tabular font-medium">Ø {eur(s.avg_eur)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!!receipts?.length && (
          <div>
            <Label>{t('names.receipts')}</Label>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {receipts.map(r => (
                <Link
                  key={r.id}
                  to={`/receipts/${r.id}`}
                  onClick={onClose}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                >
                  <ReceiptText size={14} className="shrink-0 text-zinc-400" />
                  <span>{fmtDate(r.datum, i18n.language)} · {r.roh_ladenname}</span>
                  {r.bild_pfad && <span className="text-xs text-emerald-600">📷</span>}
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !newName}>{t('common.save')}</Button>
        </div>
      </div>
    </Modal>
  );
}
