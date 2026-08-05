import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

/** IMAP server settings for the six mailboxes a German household actually uses. Host/port/
 *  encryption are technical identifiers, so they live here; only the per-provider `note`
 *  (the thing that trips people up — app passwords, "enable IMAP first") is translated.
 *  Mirrors SmtpHelp, but for the INCOMING (IMAP) side. */
const PROVIDERS: { name: string; host: string; port: string; enc: string; noteKey: string }[] = [
  { name: 'GMX',         host: 'imap.gmx.net',           port: '993', enc: 'SSL/TLS', noteKey: 'gmx' },
  { name: 'Web.de',      host: 'imap.web.de',            port: '993', enc: 'SSL/TLS', noteKey: 'webde' },
  { name: 'Gmail',       host: 'imap.gmail.com',         port: '993', enc: 'SSL/TLS', noteKey: 'gmail' },
  { name: 'T-Online',    host: 'secureimap.t-online.de', port: '993', enc: 'SSL/TLS', noteKey: 'tonline' },
  { name: 'Outlook.com', host: 'outlook.office365.com',  port: '993', enc: 'SSL/TLS', noteKey: 'outlook' },
  { name: 'mailbox.org', host: 'imap.mailbox.org',       port: '993', enc: 'SSL/TLS', noteKey: 'mailbox' },
];

const GOOGLE_APP_PW = 'https://myaccount.google.com/apppasswords';

/** "Wie richte ich IMAP ein?" — collapsible help for the IMAP mailbox-import setup.
 *  Collapsed by default; leads with the password problem (app passwords / enabling IMAP),
 *  which is what actually stops people, not the hostname. */
export function ImapHelp() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium text-zinc-700 dark:text-zinc-200"
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        {t('imapHelp.title')}
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-zinc-200 px-3 py-3 text-xs leading-relaxed dark:border-zinc-700">
          <div className="rounded-lg bg-amber-50 p-2.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-semibold">{t('imapHelp.pwTitle')}</p>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
              <li>
                {t('imapHelp.pwGmail')}{' '}
                <a href={GOOGLE_APP_PW} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium underline">
                  {t('imapHelp.pwGmailLink')} <ExternalLink size={11} />
                </a>
              </li>
              <li>{t('imapHelp.pwOutlook')}</li>
              <li>{t('imapHelp.pwGmxWebde')}</li>
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            {PROVIDERS.map(p => (
              <div key={p.name} className="flex flex-col gap-0.5 border-b border-zinc-100 pb-2 last:border-0 last:pb-0 dark:border-zinc-800">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-zinc-800 dark:text-zinc-100">{p.name}</span>
                  <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{p.host} · {p.port} · {p.enc}</span>
                </div>
                <span className="text-zinc-500 dark:text-zinc-400">{t(`imapHelp.note.${p.noteKey}`)}</span>
              </div>
            ))}
          </div>

          <p className="text-zinc-500 dark:text-zinc-400">{t('imapHelp.userHint')}</p>
        </div>
      )}
    </div>
  );
}
