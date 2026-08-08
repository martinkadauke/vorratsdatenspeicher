import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, Plus, X, Smartphone } from 'lucide-react';
import { isInstalledPwa, isPhone, isIos, canInstallHere } from '../lib/device';

/** Chrome's install hook. Not in lib.dom, and deliberately typed no wider than we use. */
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const SEEN = 'vds.install-prompt';
const SNOOZE_DAYS = 14;

/** ⚠️ Capture at MODULE level, not inside an effect. The browser fires beforeinstallprompt once and
 *  very early — routinely before React has mounted anything — and an event nobody caught is gone
 *  for the rest of the page's life. Missing it silently downgrades every Android user to the manual
 *  instructions, which is the outcome this component exists to avoid. */
let deferred: InstallEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();          // suppress the browser's own mini-infobar; we ask in context
    deferred = e as InstallEvent;
  });
}

function snoozedUntil(): number {
  try {
    const v = localStorage.getItem(SEEN);
    if (v === 'done') return Number.POSITIVE_INFINITY;
    return v ? Number(v) || 0 : 0;
  } catch { return 0; }
}

function remember(value: 'done' | 'later'): void {
  try {
    localStorage.setItem(SEEN, value === 'done' ? 'done' : String(Date.now() + SNOOZE_DAYS * 86_400_000));
  } catch { /* private mode: the card simply returns on the next visit */ }
}

/** "Put VDS on your home screen" — shown the first time someone opens VDS on a phone.
 *
 *  Deliberately NOT part of the onboarding coach. That sequence teaches the app and waits for
 *  milestones; this is about the device, it is true the moment they arrive, and it is most useful
 *  before they have typed anything. An installed VDS opens without the browser bar, keeps them
 *  signed in, and on iOS it is the precondition for notifications at all. */
export function PwaInstallPrompt() {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isPhone() || isInstalledPwa() || !canInstallHere()) return;
    if (Date.now() < snoozedUntil()) return;
    // A short delay so it does not land on a page that is still assembling itself.
    const id = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(id);
  }, []);

  // Installed while the card was open, or from the browser menu — then say nothing further.
  useEffect(() => {
    const done = () => { remember('done'); setShow(false); };
    window.addEventListener('appinstalled', done);
    return () => window.removeEventListener('appinstalled', done);
  }, []);

  if (!show) return null;

  const install = async () => {
    if (!deferred) return;
    setBusy(true);
    try {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      remember(outcome === 'accepted' ? 'done' : 'later');
      deferred = null;
      setShow(false);
    } catch { setBusy(false); }
  };

  const later = () => { remember('later'); setShow(false); };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
      <div className="mx-auto max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-3 flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            <Smartphone size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold">{t('install.title')}</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('install.body')}</p>
          </div>
          <button onClick={later} aria-label={t('install.later')}
            className="-mr-1 -mt-1 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={18} />
          </button>
        </div>

        {/* iOS has no install API at all — Safari only offers the Share sheet. Pointing at it
            precisely is honest; a button that cannot install anything is not. */}
        {deferred && !isIos() ? (
          <button onClick={install} disabled={busy}
            className="w-full rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            {busy ? '…' : t('install.cta')}
          </button>
        ) : (
          <div className="rounded-xl bg-zinc-100 p-3 text-[12px] leading-relaxed text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
            {isIos() ? (
              <span className="flex flex-wrap items-center gap-1">
                {t('install.iosPre')} <Share size={14} className="inline" /> {t('install.iosMid')}
                <Plus size={14} className="inline" /> {t('install.iosPost')}
              </span>
            ) : t('install.manual')}
          </div>
        )}
      </div>
    </div>
  );
}
