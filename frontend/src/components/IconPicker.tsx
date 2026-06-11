import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { api } from '../api/client';
import { Modal, Input, Button, Spinner } from './ui';

interface IconHit {
  src: string;
  thumb: string;
  page: string;
  title: string;
  source: string;
}

export function IconPicker({ canonicalName, open, onClose }: {
  canonicalName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [query, setQuery] = useState(canonicalName);

  useEffect(() => {
    if (open) setQuery(canonicalName);
  }, [open, canonicalName]);

  const { data: current } = useQuery({
    queryKey: ['canonical-icon', canonicalName],
    queryFn: () => api<{ icon_url: string | null; source: string | null }>(`/api/canonical/${encodeURIComponent(canonicalName)}/icon`),
    enabled: open,
  });

  const { data: searchResults, isFetching: searching, refetch } = useQuery({
    queryKey: ['icon-search', query],
    queryFn: () => api<{ results: IconHit[] }>(`/api/icons/search?q=${encodeURIComponent(query)}`),
    enabled: false,
  });

  const setIcon = useMutation({
    mutationFn: (icon_url: string | null) =>
      api(`/api/canonical/${encodeURIComponent(canonicalName)}/icon`, {
        method: 'PUT',
        body: { icon_url, source: icon_url ? 'searxng' : null },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['canonical-icon', canonicalName] });
      void qc.invalidateQueries({ queryKey: ['canonical-icons'] });
      onClose();
    },
  });

  return (
    <Modal open={open} onClose={onClose} title={`${t('iconPicker.title')}: ${canonicalName}`} wide>
      <div className="flex flex-col gap-3">
        {current?.icon_url && (
          <div className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
            <img
              src={current.icon_url}
              alt=""
              className="h-12 w-12 rounded-lg border border-zinc-100 bg-white object-cover dark:border-zinc-800"
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-zinc-500">{t('iconPicker.current')}</div>
              <div className="truncate text-xs text-zinc-400">{current.source ?? '–'}</div>
            </div>
            <Button variant="ghost" className="text-red-500" onClick={() => setIcon.mutate(null)}>
              <X size={16} />
            </Button>
          </div>
        )}

        <form
          onSubmit={e => { e.preventDefault(); void refetch(); }}
          className="flex items-center gap-2"
        >
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <Input
              className="pl-9"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('iconPicker.searchPlaceholder')}
            />
          </div>
          <Button type="submit" disabled={!query || searching}>
            {searching ? '…' : t('iconPicker.search')}
          </Button>
        </form>

        {searching && <Spinner />}

        {searchResults?.results && (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {searchResults.results.map((hit, i) => (
              <button
                key={i}
                onClick={() => setIcon.mutate(hit.src)}
                disabled={setIcon.isPending}
                className="group relative aspect-square overflow-hidden rounded-xl border border-zinc-200 bg-white hover:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-800"
                title={hit.title}
              >
                <img
                  src={hit.thumb || hit.src}
                  alt={hit.title}
                  loading="lazy"
                  className="h-full w-full object-cover"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </button>
            ))}
            {searchResults.results.length === 0 && (
              <p className="col-span-full py-6 text-center text-sm text-zinc-400">{t('iconPicker.noResults')}</p>
            )}
          </div>
        )}

        {!searchResults && !searching && (
          <p className="py-4 text-center text-xs text-zinc-400">{t('iconPicker.hint')}</p>
        )}
      </div>
    </Modal>
  );
}

/** Small displayer used inline next to canonical names. Falls back to emoji or a placeholder dot. */
export function CanonicalIcon({ name, size = 28, fallback }: { name: string; size?: number; fallback?: string }) {
  const { data: icons } = useQuery({
    queryKey: ['canonical-icons', name],
    queryFn: () => api<Record<string, string>>(`/api/canonical/icons?names=${encodeURIComponent(name)}`),
    staleTime: 60_000,
    enabled: !!name,
  });
  const url = icons?.[name];
  if (!url) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-md bg-zinc-100 text-xs dark:bg-zinc-800"
        style={{ width: size, height: size }}
      >
        {fallback ?? '·'}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className="shrink-0 rounded-md border border-zinc-200 bg-white object-cover dark:border-zinc-700 dark:bg-zinc-900"
      style={{ width: size, height: size }}
    />
  );
}
