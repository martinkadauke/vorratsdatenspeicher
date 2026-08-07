import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Megaphone, Mail, Link as LinkIcon, X as XIcon } from 'lucide-react';
import { toast } from './Toast';
import { useEscapeLayer, useScrollLock } from './ui';

// Always points at the public site, never the user's own instance — this is "tell your friends
// about VDS", not "share my data".
const SHARE_URL = 'https://vorratsdatenspeicher.com';

/** "Vorratsdatenspeicher weiterempfehlen" — header button next to the bug/bell/profile icons, in
 *  every build. On mobile it opens the OS share sheet (covers WhatsApp, Mastodon apps, Mail, …);
 *  on desktop a small popup with per-network buttons (Gizmodo-style) + copy link. */
export function RecommendButton() {
  const { t, i18n } = useTranslation();
  const de = i18n.language.startsWith('de');
  const [open, setOpen] = useState(false);
  useEscapeLayer(open, () => setOpen(false));
  useScrollLock(open);

  const title = t('recommend.title');
  const text = t('recommend.text');
  const shareText = `${text} ${SHARE_URL}`;

  const openShare = async () => {
    // Native share sheet where available (phones) — the friendliest path, and it already lists
    // every app the user has (Mastodon clients, mail, messengers). Desktop falls through to the popup.
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try { await navigator.share({ title, text, url: SHARE_URL }); } catch { /* cancelled — fine */ }
      return;
    }
    setOpen(true);
  };

  // Mastodon is federated → no single share URL. Ask (and remember) the user's instance, then use
  // that instance's /share intent.
  const shareMastodon = () => {
    const prev = localStorage.getItem('vds:mastodon') ?? '';
    const raw = window.prompt(t('recommend.mastodonPrompt'), prev);
    const inst = (raw ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!inst) return;
    localStorage.setItem('vds:mastodon', inst);
    window.open(`https://${inst}/share?text=${encodeURIComponent(shareText)}`, '_blank', 'noopener,noreferrer');
    setOpen(false);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(SHARE_URL);
      toast(t('recommend.copied'), 'success');
      setOpen(false);
    } catch { toast(t('recommend.copyFailed'), 'error'); }
  };

  const targets: Array<{ key: string; label: string; bg: string; mark?: string; icon?: JSX.Element; href?: string; onClick?: () => void }> = [
    { key: 'facebook', label: 'Facebook', bg: '#1877F2', mark: 'f', href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_URL)}` },
    { key: 'threads', label: 'Threads', bg: '#000000', mark: '@', href: `https://www.threads.net/intent/post?text=${encodeURIComponent(shareText)}` },
    { key: 'x', label: 'X', bg: '#000000', mark: '𝕏', href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(SHARE_URL)}` },
    { key: 'reddit', label: 'Reddit', bg: '#FF4500', mark: 'r/', href: `https://www.reddit.com/submit?url=${encodeURIComponent(SHARE_URL)}&title=${encodeURIComponent(title)}` },
    { key: 'mastodon', label: 'Mastodon', bg: '#6364FF', mark: '🐘', onClick: shareMastodon },
    { key: 'email', label: de ? 'E-Mail' : 'Email', bg: '#52525b', icon: <Mail size={18} />, href: `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${text}\n\n${SHARE_URL}`)}` },
  ];

  return (
    <>
      <button
        onClick={openShare} title={title} aria-label={title}
        className="flex h-9 w-9 items-center justify-center rounded-xl text-emerald-600 transition-colors hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
      >
        <Megaphone size={18} />
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => setOpen(false)}>
          <div className="w-full max-w-xs rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-bold"><Megaphone size={16} className="text-emerald-600 dark:text-emerald-400" /> {title}</h2>
              <button onClick={() => setOpen(false)} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><XIcon size={16} /></button>
            </div>
            <p className="mb-4 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('recommend.blurb')}</p>

            <div className="grid grid-cols-3 gap-x-2 gap-y-4">
              {targets.map(tg => {
                const inner = (
                  <>
                    <span className="flex h-11 w-11 items-center justify-center rounded-full text-lg font-bold leading-none text-white" style={{ background: tg.bg }}>
                      {tg.icon ?? tg.mark}
                    </span>
                    <span className="text-[11px] text-zinc-600 dark:text-zinc-300">{tg.label}</span>
                  </>
                );
                const cls = 'flex flex-col items-center gap-1.5 rounded-lg py-1 transition-opacity hover:opacity-80';
                return tg.href
                  ? <a key={tg.key} href={tg.href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} className={cls}>{inner}</a>
                  : <button key={tg.key} type="button" onClick={tg.onClick} className={cls}>{inner}</button>;
              })}
            </div>

            <button
              onClick={copyLink}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-300 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              <LinkIcon size={15} /> {t('recommend.copy')}
            </button>

            {/* Follow / visit — the project's own X account + site. */}
            <div className="mt-3 flex items-center justify-center gap-3 border-t border-zinc-100 pt-3 text-[11px] text-zinc-400 dark:border-zinc-800">
              <a href="https://x.com/vorratsdaten" target="_blank" rel="noopener noreferrer" className="font-medium hover:text-zinc-600 dark:hover:text-zinc-200">𝕏 @vorratsdaten</a>
              <span aria-hidden>·</span>
              <a href="https://vorratsdatenspeicher.com" target="_blank" rel="noopener noreferrer" className="font-medium hover:text-zinc-600 dark:hover:text-zinc-200">vorratsdatenspeicher.com</a>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
