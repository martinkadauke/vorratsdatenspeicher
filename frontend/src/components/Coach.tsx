import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { CoachMark } from './CoachMark';
import { useCoach } from './useCoach';
import { useAuth } from '../context/auth';
import { pushSupported, enablePush } from '../lib/push';
import { toast } from './Toast';
import { Button, Input } from './ui';
import { PhoneConnectPanel, useTunnel } from './PhoneConnectButton';

/** Global onboarding-coach driver (FB-01) — mounted once in Layout, off-demo only. Handles
 *  the route-agnostic stages B (VDS aufs Handy) and C (Push aktivieren); Stage A lives on the
 *  receipt page. Strictly sequential: B needs A dismissed, C needs B dismissed. */
export function Coach() {
  // Only the Electron build has a tunnel to offer; in Docker this is false and the branch below
  // never runs, so the same component serves both channels.
  const desktopBuild = useTunnel(false).enabled;
  const { enabled, coach, dismiss } = useCoach();
  const { pathname } = useLocation();
  const [snoozed, setSnoozed] = useState<Set<string>>(new Set());   // session-only soft closes

  // ⚠️ Count navigations AFTER the milestones are met, not since the app opened. Counting from
  // mount meant the card almost always appeared inside Prüfen — the two navigations were spent
  // getting there and confirming a name, so it popped in the middle of that work. Three moves
  // afterwards puts it wherever the user has actually gone next, which is the point: it is an
  // offer to make later, not an interruption of the task that earned it.
  const readyForPhone = !!coach?.dismissed.includes('A')
    && !!coach?.events.pruefen_visited && !!coach?.milestones.artikelname_set;
  const [navSinceReady, setNavSinceReady] = useState(0);
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;   // mount, or a re-render on the same route
    lastPath.current = pathname;
    if (readyForPhone) setNavSinceReady(n => n + 1);
  }, [pathname, readyForPhone]);

  if (!enabled || !coach) return null;
  const done = (s: string) => coach.dismissed.includes(s);
  const soft = (s: string) => snoozed.has(s);
  const snooze = (s: string) => setSnoozed(prev => { const n = new Set(prev); n.add(s); return n; });

  // Stage B: a receipt scanned and an article name confirmed — then three moves elsewhere in the
  // app before we ask for anything.
  if (done('A') && !done('B') && !soft('B')
      && readyForPhone && navSinceReady >= 3
      && phoneInstallRelevant()) {
    return <StageB onDone={() => dismiss.mutate('B')} onLater={() => snooze('B')} />;
  }
  // Same milestone, desktop wording: there the address in StageB is loopback and useless, but the
  // app HAS a way to the phone — the tunnel behind "Handy verbinden". Suppressing the card without
  // offering that (which is what shipped yesterday) means a desktop user scans five receipts on a
  // laptop and is never told the feature exists.
  if (done('A') && !done('B') && !soft('B')
      && readyForPhone && navSinceReady >= 3
      && !phoneInstallRelevant() && !isInstalledPwa() && desktopBuild) {
    return <StageBDesktop onDone={() => dismiss.mutate('B')} onLater={() => snooze('B')} />;
  }
  // Stage C: right after B is dismissed, and only where the browser can actually do push
  // (iOS only supports it once VDS is installed as a PWA — i.e. after Stage B).
  if (done('B') && !done('C') && !soft('C') && pushSupported() && pushOfferRelevant()) {
    return <StageC onDone={() => dismiss.mutate('C')} onLater={() => snooze('C')} />;
  }
  return null;
}

/** Running as an installed PWA (home-screen icon), rather than in a browser tab. */
function isInstalledPwa(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.matchMedia?.('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** A touch device at phone size — not a laptop with a touchscreen. */
function isPhone(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.matchMedia?.('(pointer: coarse)').matches && window.innerWidth <= 900;
}

/** "Put VDS on your phone" — pointless once it IS on the phone, and impossible to act on when the
 *  address it hands out only resolves on this one machine (the desktop build binds to loopback by
 *  design). On a Docker box reachable at a LAN address it stays useful on the desktop: that is
 *  where you can read the address off the screen and type it into the phone. */
function phoneInstallRelevant(): boolean {
  if (typeof window === 'undefined') return false;
  if (isInstalledPwa()) return false;
  return !/^(127\.|localhost|\[?::1)/.test(window.location.hostname);
}

/** Push notifications: only worth offering on a phone, and only once VDS is installed there.
 *  iOS refuses web push entirely until the PWA sits on the home screen, so asking earlier is a
 *  promise the browser cannot keep — and on a desktop it is simply the wrong device. */
function pushOfferRelevant(): boolean {
  return isPhone() && isInstalledPwa();
}

/** The desktop build's version of "put VDS on your phone": one button, which opens the very
 *  dialog the header carries. No instructions to recite — the tunnel does the work. */
function StageBDesktop({ onDone, onLater }: { onDone: () => void; onLater: () => void }) {
  const { t } = useTranslation();
  return (
    <CoachMark title={t('coach.bDesktop.title')} cta={t('coach.common.gotIt')} onCta={onDone} onLater={onLater}>
      <div className="flex flex-col gap-3">
        <p>{t('coach.bDesktop.body')}</p>
        <PhoneConnectPanel />
      </div>
    </CoachMark>
  );
}

function StageB({ onDone, onLater }: { onDone: () => void; onLater: () => void }) {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent' | 'needEmail' | 'needSmtp'>('idle');
  const [emailInput, setEmailInput] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:';

  // Send the guide. The endpoint reports *why* it can't (no_email / no_smtp) so we can guide
  // the user to fix it inline instead of a dead-end error.
  const send = async () => {
    setPhase('sending');
    try {
      await api('/api/onboarding/coach/mail-setup-guide', { method: 'POST' });
      setPhase('sent');
      toast(t('coach.b.mailSent'), 'success');
    } catch (e) {
      const code = e instanceof ApiError ? e.message : '';
      if (code === 'no_email') setPhase('needEmail');
      else if (code === 'no_smtp') setPhase('needSmtp');
      else if (code === 'rate_limited') { setPhase('idle'); toast(t('coach.b.rateLimited'), 'error'); }
      else { setPhase('idle'); toast(t('coach.b.mailFailed'), 'error'); }
    }
  };

  // no_email path: let the user set their own address, then retry (the server re-reads req.user
  // on the next request, so no re-login is needed).
  const saveEmailAndSend = async () => {
    const val = emailInput.trim();
    if (!val || savingEmail) return;
    setSavingEmail(true);
    try {
      await api('/api/me', { method: 'PATCH', body: { email: val } });
      void refreshUser();
      await send();
    } catch (e) {
      const code = e instanceof ApiError ? e.message : '';
      toast(code === 'email_taken' ? t('coach.b.emailTaken')
        : code === 'invalid_email' ? t('coach.b.emailInvalid')
        : t('coach.b.emailSaveFailed'), 'error');
    } finally {
      setSavingEmail(false);
    }
  };

  return (
    <CoachMark title={t('coach.b.title')} cta={t('coach.common.gotIt')} onCta={onDone} onLater={onLater}>
      <div className="flex flex-col gap-3">
        <p>{t('coach.b.intro')}</p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>{t('coach.b.step1')} <code className="break-all rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">{origin}</code></li>
          <li>{t('coach.b.step2i')}<br />{t('coach.b.step2a')}</li>
          {/* Only when this instance is NOT already reachable over HTTPS. Through the desktop
              build's tunnel (or any self-hoster with a certificate) telling the user to go set up
              Caddy and a VPS is advice for a problem they no longer have. */}
          {!secure && <li>{t('coach.b.step3')}</li>}
        </ol>

        {phase === 'sent' ? (
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{t('coach.b.mailSent')}</p>
        ) : phase === 'needEmail' ? (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
            <p className="text-xs text-amber-800 dark:text-amber-200">{t('coach.b.needEmail')}</p>
            <div className="flex gap-2">
              <Input type="email" autoComplete="email" placeholder={t('coach.b.emailPlaceholder')}
                value={emailInput} onChange={e => setEmailInput(e.target.value)} className="min-w-0 flex-1" />
              <Button onClick={saveEmailAndSend} disabled={savingEmail || !emailInput.trim()}>{t('coach.b.saveAndSend')}</Button>
            </div>
          </div>
        ) : phase === 'needSmtp' ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            {user?.is_admin ? t('coach.b.needSmtpAdmin') : t('coach.b.needSmtpUser')}
          </p>
        ) : secure ? null : (
          <Button variant="secondary" onClick={send} disabled={phase === 'sending'} className="self-start">
            {t('coach.b.mailBtn')}
          </Button>
        )}
      </div>
    </CoachMark>
  );
}

function StageC({ onDone, onLater }: { onDone: () => void; onLater: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const activate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await enablePush();
      toast(t('coach.c.enabled'), 'success');
      onDone();
    } catch (e) {
      toast((e as Error).message === 'denied' ? t('coach.c.denied') : t('coach.c.failed'), 'error');
      setBusy(false);
    }
  };
  return (
    <CoachMark title={t('coach.c.title')} cta={t('coach.c.enable')} onCta={activate} onNever={onDone} onLater={onLater}>
      <p>{t('coach.c.body')}</p>
    </CoachMark>
  );
}
