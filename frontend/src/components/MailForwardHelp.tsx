import { useTranslation } from 'react-i18next';

/** The six mailboxes a German household actually uses. Only the per-provider forwarding
 *  note is translated (keyed by noteKey) — the provider names are identifiers. Mirrors the
 *  SmtpHelp philosophy: describe the menu path in words (a moved path still reads as "look
 *  in Settings"; a dead deep link reads as "this is broken"). */
const PROVIDERS: { name: string; noteKey: string }[] = [
  { name: 'GMX', noteKey: 'gmx' },
  { name: 'Web.de', noteKey: 'webde' },
  { name: 'Gmail', noteKey: 'gmail' },
  { name: 'T-Online', noteKey: 'tonline' },
  { name: 'Outlook.com', noteKey: 'outlook' },
  { name: 'mailbox.org', noteKey: 'mailbox' },
];

/** Tutorial: how to make invoice e-mails land in VDS automatically — connect the mailbox
 *  via IMAP (VDS polls it) and/or set a forwarding rule at the provider so vendor invoices
 *  arrive where VDS looks. Rendered inside the Profile tutorial modal (?help=mailforward). */
export function MailForwardHelp() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      <p className="text-zinc-600 dark:text-zinc-300">{t('mailForward.intro')}</p>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-zinc-600 dark:text-zinc-300">
        <li>{t('mailForward.step1')}</li>
        <li>{t('mailForward.step2')}</li>
        <li>{t('mailForward.step3')}</li>
      </ol>
      <p className="font-semibold text-zinc-700 dark:text-zinc-200">{t('mailForward.providersTitle')}</p>
      <div className="flex flex-col gap-2">
        {PROVIDERS.map(p => (
          <div key={p.name} className="flex flex-col gap-0.5 border-b border-zinc-100 pb-2 last:border-0 last:pb-0 dark:border-zinc-800">
            <span className="font-semibold text-zinc-800 dark:text-zinc-100">{p.name}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{t(`mailForward.note.${p.noteKey}`)}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('mailForward.outro')}</p>
    </div>
  );
}
