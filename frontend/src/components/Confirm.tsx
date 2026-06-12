import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, Button } from './ui';

interface ConfirmOpts {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
interface PendingConfirm extends ConfirmOpts { resolve: (ok: boolean) => void }

let listener: ((p: PendingConfirm | null) => void) | null = null;

/** Promise-based confirm dialog. Replaces window.confirm() with an in-app
 *  modal. Usage: `if (await confirm({ message: '…' })) { … }` */
export function confirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise(resolve => {
    if (!listener) { resolve(window.confirm(opts.message)); return; }
    listener({ ...opts, resolve });
  });
}

/** Mounted once near the app root; renders whatever confirm() requests. */
export function ConfirmHost() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  useEffect(() => {
    listener = setPending;
    return () => { listener = null; };
  }, []);

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  if (!pending) return null;
  return (
    <Modal open onClose={() => close(false)} title={pending.title ?? ''}>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          {pending.danger && <AlertTriangle size={20} className="mt-0.5 shrink-0 text-red-500" />}
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{pending.message}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => close(false)}>
            {pending.cancelLabel ?? 'Abbrechen'}
          </Button>
          <Button variant={pending.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {pending.confirmLabel ?? 'OK'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
