import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Button } from './ui';

/** A centered onboarding coach popup (built on Modal). A primary CTA, an optional
 *  permanent "nicht mehr anzeigen", and a soft "später" close (session snooze). Used by
 *  the onboarding stages (A–C). Fully responsive via the underlying Modal. */
export function CoachMark({ title, children, cta, onCta, onNever, onLater }: {
  title: string;
  children: ReactNode;
  cta?: string;
  onCta?: () => void;
  /** permanent dismiss ("nicht mehr anzeigen") — omit to hide that option */
  onNever?: () => void;
  /** soft close (session snooze / reappears later) — also the Modal's ✕ / backdrop */
  onLater: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal open onClose={onLater} title={title}>
      <div className="flex flex-col gap-4">
        <div className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{children}</div>
        <div className="flex items-center justify-between gap-2">
          {onNever
            ? <button onClick={onNever} className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline dark:hover:text-zinc-200">{t('coach.never')}</button>
            : <span />}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onLater}>{t('coach.later')}</Button>
            {cta && onCta && <Button onClick={onCta}>{cta}</Button>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
