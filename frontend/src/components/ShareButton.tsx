import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share2 } from 'lucide-react';
import { Modal } from './ui';
import { cn } from '../lib/utils';

/** Share a single item (receipt / article) to another household member via the OS share sheet.
 *
 *  The Web Share API only exists in a SECURE context (HTTPS, or localhost) — a self-host served
 *  over plain http://<lan-ip>:8766 has no navigator.share. Rather than a silent clipboard
 *  fallback, we tell the user why sharing isn't available on this instance (and show the link so
 *  it's not a dead end). On a properly-hosted HTTPS instance the native picker opens as expected.
 *
 *  The link points at an existing in-app route (/receipts/:id, /warenstamm/artikel?q=…), so the
 *  recipient only ever sees what the normal visibility guards already allow — sharing a link
 *  grants no access it wouldn't otherwise have. */
export function ShareButton({ path, title, text, label, className, iconSize = 16 }: {
  path: string; title: string; text?: string; label?: string; className?: string; iconSize?: number;
}) {
  const { t } = useTranslation();
  const [showPopup, setShowPopup] = useState(false);
  const url = typeof window !== 'undefined' ? window.location.origin + path : path;
  const canShare = typeof navigator !== 'undefined'
    && typeof navigator.share === 'function'
    && typeof window !== 'undefined' && window.isSecureContext;

  const onClick = async () => {
    if (!canShare) { setShowPopup(true); return; }
    try {
      await navigator.share({ title, ...(text ? { text } : {}), url });
    } catch (e) {
      // AbortError = the user dismissed the sheet; anything else = the API refused → explain.
      if ((e as Error).name !== 'AbortError') setShowPopup(true);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        title={t('share.button')}
        aria-label={t('share.button')}
        className={cn('inline-flex items-center gap-1', className ?? 'shrink-0 rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800')}
      >
        <Share2 size={iconSize} />
        {label && <span className="text-sm">{label}</span>}
      </button>

      {showPopup && (
        <Modal open onClose={() => setShowPopup(false)} title={t('share.unavailableTitle')}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">{t('share.unavailableBody')}</p>
            <div className="rounded-lg bg-zinc-100 p-2 font-mono text-xs break-all text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">{url}</div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('share.unavailableHint')}</p>
          </div>
        </Modal>
      )}
    </>
  );
}
