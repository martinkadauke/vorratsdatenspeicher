import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { CoachMark } from './CoachMark';
import { useCoach } from './useCoach';
import { pushSupported, enablePush } from '../lib/push';
import { toast } from './Toast';
import { Button } from './ui';

/** Global onboarding-coach driver (FB-01) — mounted once in Layout, off-demo only. Handles
 *  the route-agnostic stages B (VDS aufs Handy) and C (Push aktivieren); Stage A lives on the
 *  receipt page. Strictly sequential: B needs A dismissed, C needs B dismissed. */
export function Coach() {
  const { enabled, coach, dismiss } = useCoach();
  const { pathname } = useLocation();
  const [navCount, setNavCount] = useState(0);
  const [snoozed, setSnoozed] = useState<Set<string>>(new Set());   // session-only soft closes
  useEffect(() => { setNavCount(n => n + 1); }, [pathname]);

  if (!enabled || !coach) return null;
  const done = (s: string) => coach.dismissed.includes(s);
  const soft = (s: string) => snoozed.has(s);
  const snooze = (s: string) => setSnoozed(prev => { const n = new Set(prev); n.add(s); return n; });

  // Stage B: A dismissed + Prüfen visited + ≥1 Artikelname set + a couple of navigations
  // (the nav grace stops it popping the instant an article name is confirmed).
  if (done('A') && !done('B') && !soft('B')
      && coach.events.pruefen_visited && coach.milestones.artikelname_set && navCount >= 2) {
    return <StageB onDone={() => dismiss.mutate('B')} onLater={() => snooze('B')} />;
  }
  // Stage C: right after B is dismissed, and only where the browser can actually do push
  // (iOS only supports it once VDS is installed as a PWA — i.e. after Stage B).
  if (done('B') && !done('C') && !soft('C') && pushSupported()) {
    return <StageC onDone={() => dismiss.mutate('C')} onLater={() => snooze('C')} />;
  }
  return null;
}

function StageB({ onDone, onLater }: { onDone: () => void; onLater: () => void }) {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const { data: mail } = useQuery({
    queryKey: ['mail-status'],
    queryFn: () => api<{ ok: boolean; reason: string | null }>('/api/bug-reports/mail-status'),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const sendGuide = async () => {
    setSending(true);
    try {
      await api('/api/onboarding/coach/mail-setup-guide', { method: 'POST' });
      setSent(true);
      toast(t('coach.b.mailSent'), 'success');
    } catch {
      toast(t('coach.b.mailFailed'), 'error');
    } finally {
      setSending(false);
    }
  };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <CoachMark title={t('coach.b.title')} cta={t('coach.common.gotIt')} onCta={onDone} onLater={onLater}>
      <div className="flex flex-col gap-3">
        <p>{t('coach.b.intro')}</p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>{t('coach.b.step1')} <code className="break-all rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">{origin}</code></li>
          <li>{t('coach.b.step2i')}<br />{t('coach.b.step2a')}</li>
          <li>{t('coach.b.step3')}</li>
        </ol>
        {mail?.ok && (
          <Button variant="secondary" onClick={sendGuide} disabled={sending || sent} className="self-start">
            {sent ? t('coach.b.mailSentShort') : t('coach.b.mailBtn')}
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
