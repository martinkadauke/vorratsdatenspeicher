import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ExternalLink, BadgePercent, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { Card, Spinner, EmptyState, Badge, Button } from '../components/ui';
import { useAuth } from '../context/auth';
import { toast } from '../components/Toast';
import { FirstVisitHint } from '../components/FirstVisitHint';
import { fmtDate } from '../lib/utils';

interface Offer {
  id: number; canonical_name: string; store: string | null; price: string | null;
  old_price: string | null; valid_until: string | null; source_url: string | null;
  confidence: number | null; found_at: string;
  brand: string | null; image_url: string | null; unit: string | null; source: string | null;
}

export function Offers() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canWrite = user?.can_write !== false;
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['offers-mine'],
    queryFn: () => api<Offer[]>('/api/offers/mine'),
  });

  const refresh = async () => {
    setBusy(true);
    try {
      await api('/api/offers/refresh', { method: 'POST' });
      // poll until the background search finishes (max ~80s), then reload
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const s = await api<{ running: boolean }>('/api/offers/status');
        if (!s.running) break;
      }
      await qc.invalidateQueries({ queryKey: ['offers-mine'] });
      toast(t('offers.refreshDone'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-bold">{t('offers.title')}</h1>
        {canWrite && (
          <Button variant="secondary" onClick={refresh} disabled={busy} className="shrink-0">
            <RefreshCw size={15} className={busy ? 'animate-spin' : ''} />
            {busy ? t('offers.refreshing') : t('offers.refresh')}
          </Button>
        )}
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('offers.hint')}</p>
      <FirstVisitHint id="offers" titleKey="hint.offers.title" bodyKey="hint.offers.body" />
      {busy && <p className="text-xs text-emerald-600 dark:text-emerald-500">{t('offers.refreshingHint')}</p>}

      {isLoading && <Spinner />}
      {!isLoading && !data?.length && <EmptyState>{t('offers.empty')}</EmptyState>}

      <div className="flex flex-col gap-2">
        {data?.map(o => (
          <Card key={o.id} className="flex items-center gap-3 p-3">
            {o.image_url
              ? <img src={o.image_url} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-md object-contain"
                     onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
              : <BadgePercent size={20} className="shrink-0 text-emerald-500" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{o.canonical_name}</span>
                {o.brand && <span className="text-xs text-zinc-400">{o.brand}</span>}
                {o.store && <span className="text-sm text-zinc-500">@ {o.store}</span>}
                {o.price && <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-500">{o.price}{o.unit ? `/${o.unit}` : ''}</span>}
                {o.old_price && <span className="text-xs text-zinc-400 line-through">{o.old_price}</span>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400">
                {o.valid_until && <span>{t('offers.until')} {o.valid_until}</span>}
                <span>· {fmtDate(o.found_at, i18n.language)}</span>
                {o.source === 'marktguru' && <Badge>marktguru</Badge>}
                {o.confidence != null && o.source !== 'marktguru' && <Badge>{Math.round(o.confidence * 100)}%</Badge>}
              </div>
            </div>
            {o.source_url && (
              <a href={o.source_url} target="_blank" rel="noopener noreferrer"
                 className="shrink-0 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30">
                <ExternalLink size={13} /> {t('offers.source')}
              </a>
            )}
          </Card>
        ))}
      </div>

      {!!data?.length && <p className="text-[11px] text-zinc-400">{t('offers.disclaimer')}</p>}
    </div>
  );
}
