import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';

interface VersionResp {
  sha: string; ref: string; version: string | null;
  env: string | null; demo: boolean; node: string; started_at: string;
}

/** The running build, as precisely as possible — for support when handing VDS to test users:
 *  the semver of a release (or the branch on a dev build), the exact git commit, the runtime
 *  environment, and when this container started. Shown in Admin and Profile. */
export function AppVersion({ className }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const { data } = useQuery<VersionResp>({
    queryKey: ['app-version'],
    queryFn: () => api('/api/version'),
    staleTime: 60 * 60 * 1000,
  });
  if (!data) return null;

  const unknown = (s: string | null | undefined) => !s || s === 'unknown';
  // A release image bakes a semver; a dev/branch build has none, so fall back to the ref.
  const release = data.version ? `v${data.version}` : (!unknown(data.ref) ? data.ref : t('version.dev'));
  const sha = unknown(data.sha) ? null : data.sha.slice(0, 12);
  const started = (() => {
    const d = new Date(data.started_at);
    return isNaN(d.getTime()) ? null : d.toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  })();

  return (
    <div className={className ?? 'text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500'}>
      <div>
        {t('version.label')}:{' '}
        <span className="font-mono font-semibold text-zinc-600 dark:text-zinc-300">{release}</span>
        {sha && <> · <span className="font-mono" title={data.sha}>{sha}</span></>}
      </div>
      <div className="tabular">
        {!unknown(data.env) && <>{t('version.env')}: <span className="font-medium">{data.env}</span> · </>}
        {data.node}
        {started && <> · {t('version.startedAt', { when: started })}</>}
      </div>
    </div>
  );
}
