import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

const TONES = ['', '🏻', '🏼', '🏽', '🏾', '🏿'];          // default + Fitzpatrick skin tones
const PEOPLE = ['🧑', '👨', '👩', '👦', '👧', '👶'];        // each × 6 tones

/** Curated emoji set: people in all skin tones first, then a few pets/fun ones. */
export const EMOJI_PRESETS = [
  ...PEOPLE.flatMap(b => TONES.map(t => b + t)),
  '🧒', '🧔', '🧓', '👴', '👵',
  '🐱', '🐶', '🦊', '🐻', '🐼', '🐰', '🐸', '🐵', '🦄', '🐢', '🐧', '🐷',
  '😀', '😎', '🤓', '🥳', '🙂', '🤖', '🌟', '🔥', '🌈', '🍀', '🚀', '⚡', '🍎', '🥑', '☕', '🎨',
];

/** Inline grid picker + free-text fallback (used on Profile / Reset where there's room). */
export function EmojiPicker({ value, onChange }: { value: string | null | undefined; onChange: (emoji: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid max-h-40 grid-cols-8 gap-1.5 overflow-y-auto sm:grid-cols-10">
        {EMOJI_PRESETS.map((e, i) => (
          <button
            key={`${e}-${i}`}
            type="button"
            onClick={() => onChange(e)}
            aria-label={e}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-lg border text-lg transition',
              value === e
                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40'
                : 'border-zinc-200 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800',
            )}
          >
            {e}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={value ?? ''}
        onChange={e => onChange(e.target.value.slice(0, 8))}
        placeholder="eigenes Emoji …"
        className="h-9 w-28 rounded-xl border border-zinc-300 bg-transparent px-3 text-center text-lg focus:border-emerald-500 focus:outline-none dark:border-zinc-700"
      />
    </div>
  );
}

/** Compact swatch that opens a grid popover (used in tight rows like the onboarding
 *  wizard). Closes on outside click. Same curated set incl. skin tones. */
export function EmojiSelect({ value, onChange, className }: { value: string; onChange: (e: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <div ref={ref} className={cn('relative shrink-0', className)}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex h-10 w-12 items-center justify-center rounded-xl border border-zinc-300 text-xl hover:border-emerald-400 dark:border-zinc-700">
        {value || '🙂'}
      </button>
      {open && (
        <div className="absolute z-[70] mt-1 grid max-h-52 w-[17rem] grid-cols-8 gap-0.5 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          {EMOJI_PRESETS.map((e, i) => (
            <button key={`${e}-${i}`} type="button" onClick={() => { onChange(e); setOpen(false); }}
              className={cn('rounded-lg p-1 text-xl hover:bg-zinc-100 dark:hover:bg-zinc-800', e === value && 'bg-emerald-100 dark:bg-emerald-950/50')}>
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
