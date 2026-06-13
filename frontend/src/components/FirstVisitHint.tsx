import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, X } from 'lucide-react';

/** A one-time dismissible tip shown the first time a user lands on a page/context.
 *  Dismissal persists in localStorage under `vds.hint.<id>`. */
export function FirstVisitHint({ id, titleKey, bodyKey, className }: {
  id: string;
  titleKey: string;
  bodyKey: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const key = `vds.hint.${id}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  });
  if (dismissed) return null;
  const close = () => {
    try { localStorage.setItem(key, '1'); } catch { /* ignore */ }
    setDismissed(true);
  };
  return (
    <div className={`relative flex items-start gap-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800/60 dark:bg-emerald-950/40 ${className ?? 'mb-3'}`}>
      <Sparkles size={18} className="mt-0.5 shrink-0 text-emerald-500" />
      <div className="min-w-0 flex-1 pr-5">
        <div className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">{t(titleKey)}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-emerald-700/90 dark:text-emerald-300/80">{t(bodyKey)}</p>
      </div>
      <button
        onClick={close}
        className="absolute right-2 top-2 rounded-lg p-1 text-emerald-500 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
        aria-label={t('common.gotIt')}
      >
        <X size={15} />
      </button>
    </div>
  );
}
