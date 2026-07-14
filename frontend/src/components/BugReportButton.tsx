import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bug, X } from 'lucide-react';
import { api } from '../api/client';

/** Demo feedback: a small floating button (bottom-left, above the mobile nav) on every
 *  page. Opens a modal that posts a bug report; the current page + household go along. */
export function BugReportButton() {
  const { i18n } = useTranslation();
  const de = i18n.language.startsWith('de');
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (!msg.trim() || sending) return;
    setSending(true);
    try {
      await api('/api/bug-reports', { method: 'POST', body: { message: msg, page: pathname } });
      setSent(true); setMsg('');
      setTimeout(() => { setOpen(false); setSent(false); }, 1700);
    } catch { /* swallow — feedback should never surface an error */ } finally { setSending(false); }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={de ? 'Fehler / Feedback melden' : 'Report a bug / feedback'}
        className="fixed bottom-20 left-3 z-40 flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white/95 px-3 py-2 text-xs font-medium text-zinc-600 shadow-lg backdrop-blur transition-colors hover:text-emerald-600 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-300 dark:hover:text-emerald-400 md:bottom-4"
      >
        <Bug size={15} /> Feedback
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => setOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={e => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-bold"><Bug size={18} /> {de ? 'Fehler / Feedback melden' : 'Report a bug / feedback'}</h2>
              <button onClick={() => setOpen(false)} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={18} /></button>
            </div>
            {sent ? (
              <p className="py-6 text-center text-sm font-medium text-emerald-600">{de ? 'Danke! Deine Meldung ist angekommen. 🙏' : 'Thanks! Your report was received. 🙏'}</p>
            ) : (
              <>
                <p className="mb-2 text-xs text-zinc-500">{de ? 'Was ist passiert? (die aktuelle Seite wird mitgeschickt)' : 'What happened? (the current page is included)'}</p>
                <textarea
                  value={msg} onChange={e => setMsg(e.target.value)} rows={4} autoFocus
                  placeholder={de ? 'Beschreibe kurz den Fehler oder deine Idee…' : 'Briefly describe the bug or your idea…'}
                  className="w-full resize-none rounded-xl border border-zinc-300 bg-zinc-50 p-3 text-sm outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-800"
                />
                <div className="mt-3 flex justify-end gap-2">
                  <button onClick={() => setOpen(false)} className="rounded-xl px-3 py-2 text-sm font-medium text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">{de ? 'Abbrechen' : 'Cancel'}</button>
                  <button onClick={submit} disabled={!msg.trim() || sending} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40">{sending ? '…' : (de ? 'Senden' : 'Send')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
