import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

/** The six mailboxes a German self-hoster actually has. Host/port/encryption are technical
 *  identifiers, so they live here rather than in the i18n files — only the `note` (the thing
 *  that trips people up) is translated, keyed by `noteKey`.
 *
 *  Every one of them is 587/STARTTLS today, which is why the port column looks redundant: it
 *  is there so someone comparing this list with a stale forum post sees at a glance that 465
 *  is not what we mean (and `smtp.secure` therefore stays OFF — see the hint below the list). */
const PROVIDERS: { name: string; host: string; port: string; enc: string; noteKey: string }[] = [
  { name: 'GMX',         host: 'mail.gmx.net',           port: '587', enc: 'STARTTLS', noteKey: 'gmx' },
  { name: 'Web.de',      host: 'smtp.web.de',            port: '587', enc: 'STARTTLS', noteKey: 'webde' },
  { name: 'Gmail',       host: 'smtp.gmail.com',         port: '587', enc: 'STARTTLS', noteKey: 'gmail' },
  { name: 'T-Online',    host: 'securesmtp.t-online.de', port: '587', enc: 'STARTTLS', noteKey: 'tonline' },
  { name: 'Outlook.com', host: 'smtp-mail.outlook.com',  port: '587', enc: 'STARTTLS', noteKey: 'outlook' },
  { name: 'mailbox.org', host: 'smtp.mailbox.org',       port: '587', enc: 'STARTTLS', noteKey: 'mailbox' },
];

/** Google's app-password page is the one deep link here that is stable enough to hand out;
 *  every other provider gets its path described in words. A menu path that has moved still
 *  reads as "look around Settings", a dead URL reads as "this software is broken". */
const GOOGLE_APP_PW = 'https://myaccount.google.com/apppasswords';

/** "Wie richte ich SMTP ein?" — the help panel inside the SMTP setup dialog.
 *  Collapsed by default: someone who already knows their provider should see the form, not a
 *  wall of text. It leads with the password problem because that, not the hostname, is what
 *  actually stops people: Gmail, Outlook.com and T-Online all reject the normal account
 *  password, and a first attempt that fails on "wrong password" gets blamed on VDS. */
export function SmtpHelp() {
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
        {t('smtpHelp.title')}
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-zinc-200 px-3 py-3 text-xs leading-relaxed dark:border-zinc-700">
          <div className="rounded-lg bg-amber-50 p-2.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-semibold">{t('smtpHelp.pwTitle')}</p>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
              <li>
                {t('smtpHelp.pwGmail')}{' '}
                <a href={GOOGLE_APP_PW} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-medium underline">
                  {t('smtpHelp.pwGmailLink')} <ExternalLink size={11} />
                </a>
              </li>
              <li>{t('smtpHelp.pwOutlook')}</li>
              <li>{t('smtpHelp.pwTonline')}</li>
            </ul>
          </div>

          <div className="flex flex-col gap-2">
            {PROVIDERS.map(p => (
              <div key={p.name} className="flex flex-col gap-0.5 border-b border-zinc-100 pb-2 last:border-0 last:pb-0 dark:border-zinc-800">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-zinc-800 dark:text-zinc-100">{p.name}</span>
                  <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{p.host} · {p.port} · {p.enc}</span>
                </div>
                <span className="text-zinc-500 dark:text-zinc-400">{t(`smtpHelp.note.${p.noteKey}`)}</span>
              </div>
            ))}
          </div>

          <p className="text-zinc-500 dark:text-zinc-400">{t('smtpHelp.secureHint')}</p>
          <p className="text-zinc-500 dark:text-zinc-400">{t('smtpHelp.fromHint')}</p>
        </div>
      )}
    </div>
  );
}
