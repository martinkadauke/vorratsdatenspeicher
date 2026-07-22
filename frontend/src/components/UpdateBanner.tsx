import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, X, Copy, ExternalLink } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/auth';
import { Modal, Button } from './ui';
import { toast } from './Toast';

interface ReleaseNote { version: string; name: string; body: string; published_at: string }
interface UpdateInfo {
  channel: 'dev' | 'release';
  current: string | null;
  latest?: string;
  update_available: boolean;
  url?: string | null;
  notes: ReleaseNote[];
}

const UPGRADE_CMD = 'docker compose pull && docker compose up -d';
const DISMISS_KEY = 'vds:update-dismissed';

/** "Update verfügbar" banner for self-hosters. Only ever shows on a RELEASE build
 *  (the image carries APP_VERSION) when a newer stable release exists — a dev-channel
 *  build reports channel:'dev' and stays silent. Clicking opens what's been built since
 *  the running version, plus the one command to upgrade. Dismissal is per-version, so a
 *  later release surfaces again. Admin-only, and never on the demo (nobody there hosts it). */
export function UpdateBanner() {
  const { t } = useTranslation();
  const { user, demo } = useAuth();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
  });

  const enabled = !!user?.is_admin && !demo;
  const { data } = useQuery({
    queryKey: ['update-check'],
    queryFn: () => api<UpdateInfo>('/api/update-check'),
    enabled,
    staleTime: 6 * 60 * 60 * 1000,   // backend caches too; this just avoids refetch churn
    retry: false,
  });

  if (!enabled || !data?.update_available || !data.latest) return null;
  if (dismissed === data.latest) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, data.latest!); } catch { /* private mode */ }
    setDismissed(data.latest!);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(UPGRADE_CMD); toast(t('update.copied'), 'success'); }
    catch { toast(UPGRADE_CMD, 'info', 8000); }
  };

  return (
    <>
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 dark:border-emerald-800 dark:bg-emerald-950/40">
        <ArrowUpCircle size={18} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
        <button onClick={() => setOpen(true)} className="min-w-0 flex-1 text-left">
          <span className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
            {t('update.available', { version: data.latest })}
          </span>
          <span className="ml-2 text-xs text-emerald-700 underline dark:text-emerald-300">{t('update.whatsNew')}</span>
        </button>
        <button onClick={dismiss} title={t('update.dismiss')}
          className="shrink-0 rounded-lg p-1 text-emerald-700/70 hover:bg-emerald-100 dark:text-emerald-300/70 dark:hover:bg-emerald-900/40">
          <X size={16} />
        </button>
      </div>

      {open && (
        <Modal open onClose={() => setOpen(false)} title={t('update.title', { version: data.latest })}>
          <div className="flex flex-col gap-3">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {t('update.current', { current: data.current, latest: data.latest })}
            </p>

            <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
              {data.notes.map(n => (
                <div key={n.version} className="shrink-0 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="mb-1 flex items-baseline gap-2">
                    <span className="text-sm font-bold">{n.name || `v${n.version}`}</span>
                    <span className="text-[11px] text-zinc-400">{n.published_at?.slice(0, 10)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{n.body?.trim() || '—'}</p>
                </div>
              ))}
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('update.howto')}</p>
              <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-800">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs">{UPGRADE_CMD}</code>
                <button onClick={copy} title={t('update.copy')}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"><Copy size={15} /></button>
              </div>
            </div>

            <div className="flex justify-between gap-2">
              {data.url
                ? <a href={data.url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400">
                    {t('update.viewOnGithub')} <ExternalLink size={13} />
                  </a>
                : <span />}
              <Button variant="secondary" onClick={() => setOpen(false)}>{t('common.close')}</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
