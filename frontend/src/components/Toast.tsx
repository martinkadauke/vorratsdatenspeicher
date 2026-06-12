import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';
interface ToastItem { id: number; type: ToastType; message: string }

// ── tiny module-level pub/sub (no context needed) ──
let counter = 0;
const listeners = new Set<(items: ToastItem[]) => void>();
let items: ToastItem[] = [];

function emit() { for (const l of listeners) l(items); }

/** Show a toast from anywhere. Auto-dismisses after `ms` (0 = sticky). */
export function toast(message: string, type: ToastType = 'info', ms = 4000): number {
  const id = ++counter;
  items = [...items, { id, type, message }];
  emit();
  if (ms > 0) setTimeout(() => dismiss(id), ms);
  return id;
}
export function dismiss(id: number) {
  items = items.filter(t => t.id !== id);
  emit();
}

const ICONS = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

const STYLES: Record<ToastType, string> = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700/50 dark:bg-emerald-950/70 dark:text-emerald-200',
  error: 'border-red-300 bg-red-50 text-red-800 dark:border-red-700/50 dark:bg-red-950/70 dark:text-red-200',
  info: 'border-zinc-300 bg-white text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100',
};

const ICON_COLOR: Record<ToastType, string> = {
  success: 'text-emerald-500',
  error: 'text-red-500',
  info: 'text-zinc-400',
};

/** Mounted once near the app root. Renders the toast stack bottom-center. */
export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => { listeners.delete(setList); };
  }, []);

  if (!list.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-3 pb-[env(safe-area-inset-bottom)]">
      {list.map(t => {
        const Icon = ICONS[t.type];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur animate-[toast-in_0.2s_ease-out] ${STYLES[t.type]}`}
          >
            <Icon size={18} className={`mt-0.5 shrink-0 ${ICON_COLOR[t.type]}`} />
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{t.message}</span>
            <button onClick={() => dismiss(t.id)} className="shrink-0 rounded-md p-0.5 text-current/60 hover:bg-black/5 dark:hover:bg-white/10">
              <X size={15} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
