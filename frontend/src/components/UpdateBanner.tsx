import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowUpCircle, X, Copy, ExternalLink, Loader2, Download } from 'lucide-react';
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
  /** true only when the operator added the updater sidecar — enables one-click update. */
  self_update?: boolean;
  notes: ReleaseNote[];
}
interface VersionInfo { version: string | null; sha: string }

const UPGRADE_CMD = 'docker compose pull && docker compose up -d';
const DISMISS_KEY = 'vds:update-dismissed';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** "Update verfügbar" banner for self-hosters. Only ever shows on a RELEASE build
 *  (the image carries APP_VERSION) when a newer stable release exists — a dev-channel
 *  build reports channel:'dev' and stays silent. Clicking opens what's been built since
 *  the running version, plus the one command to upgrade. If the operator added the opt-in
 *  updater sidecar (self_update), a one-click "Jetzt aktualisieren" button applies it in
 *  place. Dismissal is per-version, so a later release surfaces again. Admin-only, and
 *  never on the demo (nobody there hosts it). */
export function UpdateBanner() {
  const { t } = useTranslation();
  const { user, demo } = useAuth();
  const [open, setOpen] = useState(false);
  // 'idle' → showing options; 'updating' → sidecar triggered, polling for the new version;
  // 'timeout' → update took too long, tell the user to reload/check the sidecar.
  const [phase, setPhase] = useState<'idle' | 'updating' | 'timeout'>('idle');
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
  if (dismissed === data.latest && phase === 'idle') return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, data.latest!); } catch { /* private mode */ }
    setDismissed(data.latest!);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(UPGRADE_CMD); toast(t('update.copied'), 'success'); }
    catch { toast(UPGRADE_CMD, 'info', 8000); }
  };

  /** Poll /api/version until the running version/sha changes, then hard-reload onto the
   *  new build. Tolerates the seconds where the container is down (fetch throws). */
  const pollUntilUpdated = async (baseVersion: string | null, baseSha: string | null) => {
    const deadline = Date.now() + 180_000;
    await sleep(4000);                                   // give the old container time to go down
    while (Date.now() < deadline) {
      try {
        const v = await fetch('/api/version', { cache: 'no-store' }).then(r => r.json()) as VersionInfo;
        const versionChanged = !!v.version && v.version !== baseVersion;
        const shaChanged = !!v.sha && !!baseSha && v.sha !== baseSha;
        if (versionChanged || shaChanged) { window.location.reload(); return; }
      } catch { /* container recreating — keep polling */ }
      await sleep(3000);
    }
    setPhase('timeout');
  };

  const startSelfUpdate = async () => {
    setPhase('updating');
    try {
      // Capture the baseline BEFORE triggering so we can detect the swap.
      const before = await fetch('/api/version', { cache: 'no-store' }).then(r => r.json()) as VersionInfo;
      await api('/api/self-update', { method: 'POST' });
      void pollUntilUpdated(before.version, before.sha);
    } catch {
      setPhase('idle');
      toast(t('update.selfFailed'), 'error');
    }
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
        <Modal open onClose={() => phase === 'updating' ? undefined : setOpen(false)} title={t('update.title', { version: data.latest })}>
          <div className="flex flex-col gap-3">
            {phase === 'updating' ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <Loader2 size={32} className="animate-spin text-emerald-600 dark:text-emerald-400" />
                <p className="text-sm font-medium">{t('update.selfUpdatingTo', { version: data.latest })}</p>
                <p className="max-w-xs text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('update.selfUpdatingBody')}</p>
              </div>
            ) : (
              <>
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

                {phase === 'timeout' && (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                    {t('update.selfTimeout')}
                  </p>
                )}

                {data.self_update ? (
                  <div className="flex flex-col gap-2">
                    <Button onClick={startSelfUpdate} className="w-full justify-center">
                      <Download size={16} /> {t('update.selfUpdate')}
                    </Button>
                    <p className="text-center text-[11px] text-zinc-500 dark:text-zinc-400">
                      {t('update.selfUpdateHint', { version: data.latest })}
                    </p>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-zinc-500 hover:underline dark:text-zinc-400">{t('update.manualAlt')}</summary>
                      <div className="mt-2 flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-800">
                        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs">{UPGRADE_CMD}</code>
                        <button onClick={copy} title={t('update.copy')}
                          className="shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"><Copy size={15} /></button>
                      </div>
                    </details>
                  </div>
                ) : (
                  <div>
                    <p className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">{t('update.howto')}</p>
                    <div className="flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-800">
                      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs">{UPGRADE_CMD}</code>
                      <button onClick={copy} title={t('update.copy')}
                        className="shrink-0 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"><Copy size={15} /></button>
                    </div>
                  </div>
                )}

                <div className="flex justify-between gap-2">
                  {data.url
                    ? <a href={data.url} target="_blank" rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400">
                        {t('update.viewOnGithub')} <ExternalLink size={13} />
                      </a>
                    : <span />}
                  <Button variant="secondary" onClick={() => setOpen(false)}>{t('common.close')}</Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
