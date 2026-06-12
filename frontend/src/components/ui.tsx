import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/utils';

// ── Button ─────────────────────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const styles: Record<ButtonVariant, string> = {
    primary: 'bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-emerald-600/50',
    secondary: 'bg-zinc-200 text-zinc-900 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700',
    ghost: 'bg-transparent text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
    danger: 'bg-red-600 text-white hover:bg-red-500',
  };
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        styles[variant],
        className,
      )}
      {...props}
    />
  );
}

// ── Card ───────────────────────────────────────────────────────────────────
export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900',
        onClick && 'cursor-pointer transition-colors hover:border-zinc-300 dark:hover:border-zinc-700',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── Input / Select / Label ─────────────────────────────────────────────────
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cn('mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400', className)}>{children}</label>;
}

// ── Badge ──────────────────────────────────────────────────────────────────
export function Badge({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300', className)}>
      {children}
    </span>
  );
}

// ── Switch ─────────────────────────────────────────────────────────────────
export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors disabled:opacity-50',
        checked ? 'bg-emerald-600' : 'bg-zinc-300 dark:bg-zinc-700',
      )}
    >
      <span
        className={cn(
          'h-5 w-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, wide }: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div
        className={cn(
          'max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl dark:bg-zinc-900 sm:rounded-2xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-md',
        )}
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Spinner & EmptyState ───────────────────────────────────────────────────
export function Spinner({ className }: { className?: string }) {
  return (
    <div className={cn('flex justify-center py-10', className)}>
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-zinc-300 border-t-emerald-600 dark:border-zinc-700 dark:border-t-emerald-500" />
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="py-12 text-center text-sm text-zinc-400 dark:text-zinc-500">{children}</div>;
}

// ── ProgressBar ──────────────────────────────────────────────────────────────
/** A determinate (value/max) or indeterminate (omit value) progress bar.
 *  Indeterminate mode shows a looping sweep — for single long-running calls
 *  with no measurable sub-steps (e.g. one OCR request). */
export function ProgressBar({ value, max, label, className }: {
  value?: number; max?: number; label?: ReactNode; className?: string;
}) {
  const determinate = typeof value === 'number' && typeof max === 'number' && max > 0;
  const pct = determinate ? Math.min(100, Math.round((value! / max!) * 100)) : 0;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          <span>{label}</span>
          {determinate && <span className="tabular font-medium">{value}/{max} · {pct}%</span>}
        </div>
      )}
      <div className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        {determinate ? (
          <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${pct}%` }} />
        ) : (
          <div className="h-full w-1/3 animate-progress-indeterminate rounded-full bg-emerald-500" />
        )}
      </div>
    </div>
  );
}
