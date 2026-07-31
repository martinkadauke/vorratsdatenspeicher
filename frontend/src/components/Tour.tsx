import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { ScanLine, X } from 'lucide-react';
import { api } from '../api/client';
import { Button, FeedbackIconButton } from './ui';
import { useAuth } from '../context/auth';

/** Pending "open the scanner" intent, handed to the Receipts page across a navigation.
 *
 *  navigate() only SCHEDULES a render, so dispatching the window event straight after it raced
 *  the Receipts listener mounting: the old code guessed 60ms, and whenever the page needed
 *  longer the event landed on nobody and the CTA opened NOTHING. A module-level flag cannot be
 *  missed — the page reads it while mounting, however long that takes. */
let pendingScan: { sample: boolean } | null = null;

/** Read-and-clear, so one intent opens the scanner exactly once (a leftover flag would make a
 *  later visit to Receipts pop the scanner out of nowhere). */
export function takePendingScan(): { sample: boolean } | null {
  const intent = pendingScan;
  pendingScan = null;
  return intent;
}

/**
 * After the setup wizard, ONE hands-on nudge: scan your first receipt. A receipt is the seed
 * of everything VDS does — only from a scan does it learn where you shop and what you buy.
 * The CTA opens the exact same scanner the Receipts "+" FAB opens; that modal's open-state
 * lives on the Receipts page, so we hand it either a pending intent (when we navigate there)
 * or the window-event bus the "replay tour" button already uses (when we are already there).
 * Dismissal persists via has_seen_tour so it shows only once.
 */
export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const canWrite = user?.can_write !== false;

  const markSeen = useMutation({
    mutationFn: () => api('/api/me', { method: 'PATCH', body: { has_seen_tour: true } }),
    onSuccess: () => void refreshUser(),
  });

  if (!open) return null;

  const dismiss = () => { markSeen.mutate(); onClose(); };
  const scanNow = () => {
    dismiss();
    // `sample` asks the modal to pre-load the bundled demo receipt (demo build only) so the
    // user can watch a real OCR run in one tap instead of hunting for a receipt photo on
    // their phone. Exactly one of the two hand-offs applies, so the scanner opens once:
    if (pathname === '/receipts') {
      // Already there — no remount happens, so nothing would ever consume a pending intent.
      // The window bus reaches the listener synchronously; no timing assumption involved.
      window.dispatchEvent(new CustomEvent('vds:new-purchase', { detail: { sample: true } }));
    } else {
      pendingScan = { sample: true };  // consumed by the Receipts page on mount
      navigate('/receipts');
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900">
        {/* z-[60] overlay → both app-wide feedback triggers are buried; carry our own. */}
        <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5">
          <FeedbackIconButton />
          <button onClick={dismiss} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label={t('tour.later')}>
            <X size={18} />
          </button>
        </div>

        <div className="flex h-32 items-center justify-center bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-950 dark:to-emerald-900">
          <div className="text-6xl">🧾</div>
        </div>

        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-500">
            <ScanLine size={18} />
            <span className="text-xs font-medium uppercase tracking-wide">{t('tour.scan.eyebrow')}</span>
          </div>
          <h2 className="text-xl font-bold">{t('tour.scan.title')}</h2>
          <p className="whitespace-pre-line text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{t('tour.scan.body')}</p>

          {canWrite ? (
            <div className="mt-2 flex flex-col gap-2">
              <Button onClick={scanNow} className="w-full justify-center py-2.5 text-[15px] font-semibold">
                <ScanLine size={17} /> {t('tour.scan.cta')}
              </Button>
              <button onClick={dismiss} className="text-center text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                {t('tour.later')}
              </button>
            </div>
          ) : (
            <Button variant="secondary" onClick={dismiss} className="mt-2 w-full justify-center">
              {t('tour.gotIt')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
