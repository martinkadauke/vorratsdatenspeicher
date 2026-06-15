import { cn } from '../lib/utils';

const PRESETS = [
  '😀', '😎', '🤓', '🥳', '🙂', '😇', '🤠', '🧑', '👩', '👨', '👧', '👦', '🧔', '👵', '👴',
  '🐱', '🐶', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐰', '🐸', '🐵', '🦄', '🐢', '🐙', '🐧',
  '🌟', '🔥', '🌈', '🍀', '🚀', '⚡', '🍎', '🥑', '🍕', '☕', '🎸', '⚽', '🎮', '📚', '🎨', '🤖',
];

export function EmojiPicker({ value, onChange }: { value: string | null | undefined; onChange: (emoji: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-10">
        {PRESETS.map(e => (
          <button
            key={e}
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
