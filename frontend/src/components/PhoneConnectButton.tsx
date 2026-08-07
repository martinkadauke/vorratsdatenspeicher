import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Smartphone, X as XIcon, Link as LinkIcon, ExternalLink, ShieldCheck, Loader2, AlertTriangle } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/auth';
import { toast } from './Toast';
import { useEscapeLayer, useScrollLock } from './ui';

// "Handy verbinden" — the desktop build's answer to "how do I photograph a receipt with my phone
// when VDS runs on my computer?". The Electron shell brings up an embedded Tailscale node and
// Funnel gives the household a stable HTTPS address; here we only show its state and turn the URL
// into something you can point a camera at.
//
// HTTPS is not cosmetic: a phone will not install the PWA or use a passkey over plain http, so the
// tunnel is what makes the phone a first-class VDS client rather than a browser tab.
//
// Docker builds never see this — the backend answers `available:false` there, and the button in
// the header is not rendered at all.

type TunnelState = 'off' | 'starting' | 'auth' | 'connecting' | 'verifying' | 'up' | 'needs_funnel' | 'needs_https' | 'unreachable' | 'error' | 'unavailable';
interface TunnelStatus {
  available: boolean;
  state: TunnelState;
  url?: string | null;
  authUrl?: string;
  helpUrl?: string;
  reason?: string;
  detail?: string;
}

/** States where something is actively happening — poll fast, and don't offer "connect" again. */
const BUSY: TunnelState[] = ['starting', 'auth', 'connecting', 'verifying'];

/** Is this the Electron build (and may this user drive the tunnel)? Both the header button and the
 *  onboarding coach need the answer, and react-query dedupes the shared keys. */
export function useTunnel(poll: boolean) {
  const { user } = useAuth();
  // /api/version is already cached by the layout; the desktop flag decides whether the
  // operator-only tunnel endpoint is worth asking at all (in Docker it would just 401).
  const { data: version } = useQuery({
    queryKey: ['version'],
    queryFn: () => api<{ desktop?: boolean }>('/api/version'),
    staleTime: Infinity,
  });
  const query = useQuery({
    queryKey: ['desktop-tunnel'],
    queryFn: () => api<TunnelStatus>('/api/desktop/tunnel'),
    enabled: !!version?.desktop && !!user?.is_admin,
    refetchInterval: poll ? 2000 : false,
    staleTime: 10_000,
  });
  return { ...query, enabled: !!version?.desktop && !!user?.is_admin };
}

/** The connect flow itself, without any dialog chrome — used by the header button AND by the
 *  onboarding coach, which on the desktop build must NOT recite the Docker instructions ("open
 *  this loopback address on your phone… then set up a reverse proxy"): that address is reachable
 *  from exactly one machine, and asking a desktop user for Caddy and a VPS is precisely the
 *  friction this build exists to remove. */
export function PhoneConnectPanel() {
  const { t } = useTranslation();
  const [qr, setQr] = useState<string | null>(null);
  const { data, refetch } = useTunnel(true);

  const act = useMutation({
    mutationFn: (action: 'start' | 'stop') => api('/api/desktop/tunnel', { method: 'POST', body: { action } }),
    onSuccess: () => { void refetch(); },
    onError: () => toast(t('phone.failed'), 'error'),
  });

  const state = data?.state ?? 'off';
  const url = data?.url ?? null;

  // Rendered in the browser — the address never leaves this machine, which is rather the point.
  useEffect(() => {
    if (state !== 'up' || !url) { setQr(null); return; }
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' })
      .then(d => { if (alive) setQr(d); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [state, url]);

  const copyUrl = async () => {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast(t('phone.copied'), 'success'); }
    catch { toast(t('phone.copyFailed'), 'error'); }
  };

  return (
    <>
      {state === 'off' && (
        <>
          <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('phone.introBlurb')}</p>
          <p className="mb-4 flex gap-2 rounded-xl bg-emerald-50 p-3 text-[11px] leading-relaxed text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            <ShieldCheck size={26} className="shrink-0" /> {t('phone.privacyBlurb')}
          </p>
          <button
            onClick={() => act.mutate('start')} disabled={act.isPending}
            className="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-60"
          >
            {t('phone.connect')}
          </button>
        </>
      )}

      {BUSY.includes(state) && (
        <>
          <p className="mb-3 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
            <Loader2 size={16} className="animate-spin text-emerald-600" />
            {state === 'auth' ? t('phone.authWaiting') : state === 'verifying' ? t('phone.verifying') : t('phone.starting')}
          </p>
          {state === 'auth' && (
            <>
              <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('phone.authBlurb')}</p>
              {data?.authUrl && (
                // Escape hatch: a sign-in provider can refuse an embedded window at any time, and
                // then the in-app login is a dead end with no way out.
                <a
                  href={data.authUrl} target="_blank" rel="noopener noreferrer"
                  className="mb-3 flex items-center justify-center gap-2 rounded-xl border border-zinc-300 py-2 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
                >
                  <ExternalLink size={14} /> {t('phone.openInBrowser')}
                </a>
              )}
            </>
          )}
          <button onClick={() => act.mutate('stop')} className="w-full rounded-xl border border-zinc-300 py-2 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
            {t('phone.cancel')}
          </button>
        </>
      )}

      {(state === 'needs_funnel' || state === 'needs_https' || state === 'unreachable') && (
        <>
          <p className="mb-3 flex gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle size={26} className="shrink-0" /> {t(state === 'needs_funnel' ? 'phone.funnelBlurb' : state === 'needs_https' ? 'phone.httpsBlurb' : 'phone.unreachableBlurb')}
          </p>
          <a
            href={data?.helpUrl || 'https://login.tailscale.com/admin/dns'} target="_blank" rel="noopener noreferrer"
            className="mb-2 flex items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            <ExternalLink size={15} /> {t(state === 'needs_funnel' ? 'phone.funnelEnable' : 'phone.httpsEnable')}
          </a>
          <p className="text-center text-[11px] text-zinc-400">{t('phone.funnelRetry')}</p>
        </>
      )}

      {state === 'up' && (
        <>
          <p className="mb-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('phone.scanBlurb')}</p>
          {qr
            ? <img src={qr} alt={url ?? ''} className="mx-auto mb-3 h-56 w-56 rounded-xl bg-white p-2" />
            : <div className="mx-auto mb-3 flex h-56 w-56 items-center justify-center"><Loader2 size={20} className="animate-spin text-zinc-400" /></div>}
          <button onClick={copyUrl} className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">
            <LinkIcon size={14} /> <span className="truncate">{url}</span>
          </button>
          <p className="mb-4 rounded-xl bg-zinc-50 p-3 text-[11px] leading-relaxed text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">{t('phone.pwaHint')}</p>
          <button onClick={() => act.mutate('stop')} className="w-full rounded-xl border border-zinc-300 py-2 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
            {t('phone.disconnect')}
          </button>
        </>
      )}

      {state === 'error' && (
        <>
          <p className="mb-2 text-sm font-medium text-red-600 dark:text-red-400">{t('phone.errorTitle')}</p>
          <p className="mb-3 break-words text-[11px] text-zinc-500 dark:text-zinc-400">{data?.reason}{data?.detail ? ` · ${data.detail}` : ''}</p>
          <button onClick={() => act.mutate('start')} className="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700">
            {t('phone.retry')}
          </button>
        </>
      )}
    </>
  );
}

export function PhoneConnectButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEscapeLayer(open, () => setOpen(false));
  useScrollLock(open);
  const { data } = useTunnel(open);

  // Desktop build + operator only. Everyone else never learns the button exists.
  if (!data?.available) return null;

  const state = data.state;
  const dot = state === 'up' ? 'bg-emerald-500'
    : BUSY.includes(state) ? 'bg-amber-400'
    : ['needs_funnel', 'needs_https', 'unreachable', 'error'].includes(state) ? 'bg-red-500'
    : 'bg-zinc-300 dark:bg-zinc-600';

  return (
    <>
      <button
        onClick={() => setOpen(true)} title={t('phone.title')} aria-label={t('phone.title')}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl text-zinc-500 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <Smartphone size={18} />
        <span className={`absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-white dark:ring-zinc-950 ${dot}`} />
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => setOpen(false)}>
          <div className="max-h-[90dvh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold"><Smartphone size={16} className="text-emerald-600 dark:text-emerald-400" /> {t('phone.title')}</h2>
              <button onClick={() => setOpen(false)} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><XIcon size={16} /></button>
            </div>
            <PhoneConnectPanel />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
