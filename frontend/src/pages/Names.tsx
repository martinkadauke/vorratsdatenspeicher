import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Search, ReceiptText, Store, Image as ImageIcon, UserCheck, Scale } from 'lucide-react';
import { api } from '../api/client';
import type { CanonicalName } from '../api/types';
import { Card, Input, Spinner, EmptyState, Badge, Modal, Button, Label } from '../components/ui';
import { CategoryPicker } from '../components/CategoryPicker';
import { UnitSelect } from '../components/UnitSelect';
import { ConsumerChips, ConsumerDots } from '../components/ConsumerChips';
import { CanonicalIcon, IconPicker } from '../components/IconPicker';
import { toast } from '../components/Toast';
import { fmtDate, eur } from '../lib/utils';

interface PriceHistory {
  canonical: string;
  base_unit: string | null;
  stores: { key: string; display: string; avg_eur: number; unit: string | null; groups: { unit: string; avg: number; min: number; n: number }[] }[];
  cheapest: { key: string; display: string; avg_eur: number } | null;
}

interface CanonicalReceipt {
  artikel_id: number; original_text: string | null; artikel_name: string | null;
  preis: number | null; menge: number | null; einheit: string | null;
  id: number; datum: string; roh_ladenname: string | null; bild_pfad: string | null;
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
            <CanonicalIcon name={n.canonical_name} size={32} />
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

export function NameEditModal({ name, onClose }: { name: CanonicalName | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [newName, setNewName] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [consumers, setConsumers] = useState<number[]>([]);
  const [exclusive, setExclusive] = useState(false);
  const [baseUnit, setBaseUnit] = useState<string | null>(null);
  const [expectedPrice, setExpectedPrice] = useState('');
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  // Reset local form state whenever a different name is opened
  useEffect(() => {
    if (!name) return;
    setNewName(name.canonical_name);
    setCategory(name.category_path);
    setConsumers(name.consumers);
    setExclusive(name.consumers_exclusive);
    setBaseUnit(name.base_unit ?? null);
    setExpectedPrice(name.expected_price != null ? String(name.expected_price).replace('.', ',') : '');
  }, [name?.canonical_name]);

  const { data: receipts } = useQuery({
    queryKey: ['name-receipts', name?.canonical_name],
    queryFn: () => api<CanonicalReceipt[]>(`/api/canonical/${encodeURIComponent(name!.canonical_name)}/receipts`),
    enabled: !!name,
  });

  const { data: prices } = useQuery({
    queryKey: ['name-prices', name?.canonical_name],
    queryFn: () => api<PriceHistory>(`/api/stores/price-history?canonical=${encodeURIComponent(name!.canonical_name)}`),
    enabled: !!name,
  });

  // Fetch the avg weekly consumption directly (unified estimateVorrat) so it's
  // always correct — independent of whether the list item passed it in.
  const { data: consumption } = useQuery({
    queryKey: ['name-consumption', name?.canonical_name],
    queryFn: () => api<{ weekly_consumption: number | null; consumption_unit: string | null; expected_avg: number | null; expected_unit: string | null }>(`/api/canonical/${encodeURIComponent(name!.canonical_name)}/consumption`),
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
      if (baseUnit !== (name.base_unit ?? null)) {
        await api(`/api/names/${encodeURIComponent(effective)}/meta`, {
          method: 'PATCH',
          body: { base_unit: baseUnit },
        });
      }
      const epParsed = expectedPrice.trim() ? parseFloat(expectedPrice.replace(',', '.')) : null;
      const epClean = epParsed != null && Number.isFinite(epParsed) && epParsed >= 0 ? epParsed : null;
      if (epClean !== (name.expected_price ?? null)) {
        await api(`/api/names/${encodeURIComponent(effective)}/meta`, {
          method: 'PATCH',
          body: { expected_price: epClean },
        });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['names'] });
      void qc.invalidateQueries({ queryKey: ['artikel-list'] });
      void qc.invalidateQueries({ queryKey: ['shopping'] });
      toast(t('common.saved'), 'success');
      onClose();
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });

  if (!name) return null;

  return (
    <Modal open={!!name} onClose={onClose} title={name.canonical_name}>
      <div className="flex flex-col gap-4">
        {/* Header: tap the icon to change it · name + the "human-confirmed" badge */}
        <div className="flex items-end gap-3">
          <button
            type="button"
            onClick={() => setIconPickerOpen(true)}
            title={t('names.changeIcon')}
            className="group relative shrink-0 rounded-xl border border-dashed border-zinc-300 p-1.5 hover:border-emerald-500 dark:border-zinc-700"
          >
            <CanonicalIcon name={name.canonical_name} size={44} />
            <span className="absolute -bottom-1 -right-1 rounded-full bg-white p-0.5 text-zinc-400 shadow group-hover:text-emerald-500 dark:bg-zinc-900">
              <ImageIcon size={12} />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <Label>{t('names.rename')}</Label>
            <div className="flex items-center gap-2">
              <Input value={newName} onChange={e => setNewName(e.target.value)} className="flex-1" />
              {name.user_corrected && (
                <span title={t('article.userCorrected')} className="shrink-0 text-emerald-500">
                  <UserCheck size={18} />
                </span>
              )}
            </div>
          </div>
        </div>

        <IconPicker
          canonicalName={name.canonical_name}
          open={iconPickerOpen}
          onClose={() => setIconPickerOpen(false)}
        />

        <div>
          <Label>{t('article.category')}</Label>
          <CategoryPicker value={category} onChange={setCategory} />
        </div>
        {/* Einheit · erwarteter Preis · Verbrauch/Woche gehören zusammen → ein
            kompakter Block. Ohne-Gewicht wird hier (statt als Listen-Icon) erklärt. */}
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col">
              <Label>{t('names.baseUnit')}</Label>
              <div className="mt-auto">
                <UnitSelect value={baseUnit} onChange={setBaseUnit} allowEmpty />
              </div>
            </div>
            <div className="flex flex-col">
              <Label>{t('names.expectedPrice')}</Label>
              <div className="mt-auto flex items-center gap-1">
                <Input
                  value={expectedPrice}
                  onChange={e => setExpectedPrice(e.target.value)}
                  placeholder={consumption?.expected_avg != null ? consumption.expected_avg.toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00'}
                  inputMode="decimal"
                  className="w-full min-w-0"
                />
                <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">€/{baseUnit || t('names.unit')}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-zinc-100 pt-2 text-sm dark:border-zinc-800">
            <span className="text-zinc-500 dark:text-zinc-400">{t('names.weeklyConsumption')}</span>
            <span className="font-semibold text-sky-700 dark:text-sky-400">
              {(() => {
                const wk = consumption?.weekly_consumption ?? name.weekly_consumption ?? null;
                const unit = consumption?.consumption_unit ?? name.consumption_unit ?? null;
                return wk != null && unit
                  ? `Ø ${Number(wk).toLocaleString(i18n.language, { maximumFractionDigits: 1 })} ${unit}`
                  : <span className="font-normal text-zinc-400">{t('names.weeklyConsumptionNone')}</span>;
              })()}
            </span>
          </div>
          {name.needs_weight && (
            <div className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              <Scale size={14} className="mt-px shrink-0" />
              <span>{t('names.needsWeightHint')}</span>
            </div>
          )}
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
                    <span className="tabular text-right text-xs font-medium">
                      {s.groups.map(g => `${g.avg.toFixed(2).replace('.', ',')} €/${g.unit}`).join(' · ')}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!!receipts?.length && (
          <div>
            <Label>{t('names.receipts')}</Label>
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {receipts.map(r => (
                <Link
                  key={r.artikel_id}
                  to={`/receipts/${r.id}?hq=${encodeURIComponent(name!.canonical_name)}`}
                  onClick={onClose}
                  className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                >
                  <div className="flex items-center gap-2">
                    <ReceiptText size={14} className="shrink-0 text-zinc-400" />
                    <span className="min-w-0 truncate">{fmtDate(r.datum, i18n.language)} · {r.roh_ladenname}</span>
                    {r.preis != null && <span className="tabular ml-auto shrink-0 text-xs font-medium">{eur(r.preis)}</span>}
                    {r.bild_pfad && <span className="shrink-0 text-xs text-emerald-600">📷</span>}
                  </div>
                  {r.original_text && (
                    <span className="truncate pl-6 text-xs italic text-zinc-400" title={r.original_text}>„{r.original_text}"</span>
                  )}
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
