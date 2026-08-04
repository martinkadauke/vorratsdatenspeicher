import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { Modal, Button } from './ui';
import { PdfPreview } from './PdfPreview';
import { eur } from '../lib/utils';

export interface RefundMailItem {
  subject: string | null;
  from: string | null;
  sent_at?: string | null;
  html: string | null;
  text: string | null;
  pdf_pfad: string | null;
  amount?: number | null;
}

/** Show the refund mail(s) behind a receipt's paperclip: the sanitised mail body in a fully
 *  sandboxed iframe (same technique as the receipt's EmailViewer) plus, if the mail carried a
 *  PDF, an inline PdfPreview — "open the PDF via the mail" per Martin. */
export function RefundMailModal({ mails, onClose }: { mails: RefundMailItem[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [openPdf, setOpenPdf] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={t('refund.mailTitle', 'Erstattungsmail')} wide>
      <div className="flex flex-col gap-4">
        {mails.map((m, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="text-sm">
              <div className="font-medium text-zinc-900 dark:text-zinc-100">{m.subject || t('refund.noSubject', '(ohne Betreff)')}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{m.from}{m.amount != null ? ` · ${eur(m.amount)}` : ''}</div>
            </div>
            {m.pdf_pfad && (
              <div>
                <Button variant="secondary" onClick={() => setOpenPdf(openPdf === m.pdf_pfad ? null : m.pdf_pfad)}>
                  <FileText size={14} className="mr-1 inline align-[-2px]" />
                  {openPdf === m.pdf_pfad ? t('refund.hidePdf', 'PDF ausblenden') : t('refund.openPdf', 'PDF öffnen')}
                </Button>
                {openPdf === m.pdf_pfad && (
                  <div className="mt-2 max-h-[28rem] overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
                    <PdfPreview url={m.pdf_pfad} />
                  </div>
                )}
              </div>
            )}
            {m.html ? (
              <iframe
                title="refund-mail"
                sandbox=""
                referrerPolicy="no-referrer"
                className="h-[50vh] w-full rounded-lg border border-zinc-200 dark:border-zinc-700"
                srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"></head><body>${m.html}</body></html>`}
              />
            ) : m.text ? (
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-700">{m.text}</pre>
            ) : null}
          </div>
        ))}
        {!mails.length && <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('refund.noMail', 'Keine Erstattungsmail gespeichert.')}</p>}
      </div>
    </Modal>
  );
}
