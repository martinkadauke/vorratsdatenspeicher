import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api/client';
import type { Artikel, ReceiptDetail } from '../api/types';
import { Card, Spinner, Badge } from '../components/ui';
import { ArticleEditModal } from '../components/ArticleEditModal';
import { ConsumerDots } from '../components/ConsumerChips';
import { CanonicalIcon } from '../components/IconPicker';
import { eur, fmtDate } from '../lib/utils';

export function ReceiptDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState<Artikel | null>(null);
  const [imageOpen, setImageOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['receipt', id],
    queryFn: () => api<ReceiptDetail>(`/api/receipts/${id}`),
    enabled: !!id,
  });

  if (isLoading) return <Spinner />;
  if (!data) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 sm:gap-3">
        <Link to="/receipts" className="shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
          <ArrowLeft size={20} />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold">{data.roh_ladenname ?? '?'}</h1>
          <div className="text-sm text-zinc-500">
            {fmtDate(data.datum, i18n.language)} · <span className="tabular font-semibold text-emerald-600 dark:text-emerald-500">{eur(data.gesamt_betrag)}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* Receipt image */}
        <div>
          {data.bild_pfad ? (
            <img
              src={data.bild_pfad}
              alt="Beleg"
              onClick={() => setImageOpen(true)}
              className="w-full cursor-zoom-in rounded-2xl border border-zinc-200 dark:border-zinc-800"
            />
          ) : (
            <div className="flex h-48 items-center justify-center rounded-2xl bg-zinc-100 text-sm text-zinc-400 dark:bg-zinc-900">
              {t('receipts.noImage')}
            </div>
          )}
        </div>

        {/* Line items */}
        <div className="flex min-w-0 flex-col gap-1.5">
          {data.artikel.map(a => (
            <Card key={a.id} onClick={() => setEditing(a)} className="flex min-w-0 items-center gap-2 px-2.5 py-2.5 sm:gap-3 sm:px-3">
              {a.canonical_name && <CanonicalIcon name={a.canonical_name} size={32} />}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-medium">{a.canonical_name ?? a.ai_guess ?? a.name}</span>
                  <ConsumerDots ids={a.consumers} />
                </div>
                {a.original_text && (
                  <div className="truncate font-mono text-[11px] text-zinc-400">{a.original_text}</div>
                )}
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {a.category_path && <Badge>{a.category_path.split('/').pop()}</Badge>}
                  {a.menge && <span className="text-xs text-zinc-400">{a.menge} {a.einheit ?? ''}</span>}
                </div>
              </div>
              <div className="tabular shrink-0 font-semibold">{eur(a.preis)}</div>
            </Card>
          ))}
        </div>
      </div>

      {/* Fullscreen image */}
      {imageOpen && data.bild_pfad && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-2" onClick={() => setImageOpen(false)}>
          <img src={data.bild_pfad} alt="Beleg" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}

      <ArticleEditModal
        artikel={editing}
        open={!!editing}
        onClose={() => setEditing(null)}
        invalidateKeys={[['receipt', id], ['receipts']]}
      />
    </div>
  );
}
