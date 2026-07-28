import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ScanLine, X } from 'lucide-react';
import { api } from '../api/client';
import { Button } from './ui';
import { useAuth } from '../context/auth';

/**
 * After the setup wizard, ONE hands-on nudge: scan your first receipt. A receipt is the seed
 * of everything VDS does — only from a scan does it learn where you shop and what you buy.
 * The CTA opens the exact same scanner the Receipts "+" FAB opens; that modal's open-state
 * lives on the Receipts page, so we trigger it via the same window-event bus the "replay tour"
 * button already uses. Dismissal persists via has_seen_tour so it shows only once.
 */
export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const canWrite = user?.can_write !== false;

  const markSeen = useMutation({
    mutationFn: () => api('/api/me', { method: 'PATCH', body: { has_seen_tour: true } }),
    onSuccess: () => void refreshUser(),
  });

  if (!open) return null;

  const dismiss = () => { markSeen.mutate(); onClose(); };
  const scanNow = () => {
    dismiss();
    navigate('/receipts');
    // Open the scanner via the window-event bus (its state is local to the Receipts page).
    // A tick after navigation so the Receipts listener is mounted. `sample` asks the modal
    // to pre-load the bundled demo receipt (demo build only) so the user can watch a real
    // OCR run in one tap instead of hunting for a receipt photo on their phone.
    setTimeout(() => window.dispatchEvent(new CustomEvent('vds:new-purchase', { detail: { sample: true } })), 60);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-zinc-900">
        <button onClick={dismiss} className="absolute right-3 top-3 z-10 rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label={t('tour.later')}>
          <X size={18} />
        </button>

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
