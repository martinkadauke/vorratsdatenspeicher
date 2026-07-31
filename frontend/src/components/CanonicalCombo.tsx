import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { Input } from './ui';
import { cn } from '../lib/utils';

export interface CanonicalNameOption { canonical_name: string; artikel_count: number }

/** The canonical-name list behind every name typeahead. The query key is shared
 *  on purpose: a second combo mounted elsewhere reads this cache instead of
 *  firing another /api/names request.
 *
 *  It sits UNDER ['names'] because every canonical-name mutation in the app
 *  already invalidates ['names'] (Prüfen, Artikel, Namen, ArticleEditModal) and
 *  React Query matches keys by prefix — a flat ['names-mini'] was never reached
 *  by any of them, so a name just taught in Prüfen was missing from the very
 *  next card's suggestions for the whole 60s staleTime (i.e. exactly when a
 *  duplicate gets minted). The object element keeps this entry distinct from
 *  Namen's ['names', search]: a search for "mini" would otherwise share it. */
export function useCanonicalNames() {
  return useQuery({
    queryKey: ['names', { combo: true }],
    queryFn: () => api<CanonicalNameOption[]>('/api/names'),
    staleTime: 60_000,
  });
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** What picking a suggestion does. Default: just fill the field — a caller
   *  that wants an action (Einkaufsliste: add the item) passes its own. */
  onPick?: (name: string) => void;
  placeholder?: string;
  /** Extra classes for the wrapper (e.g. `flex-1` inside a row). */
  className?: string;
  /** Extra classes for the <input> itself (e.g. `pl-8` to clear an icon). */
  inputClassName?: string;
  /** `overlay` floats the list over whatever sits below the field (Einkaufsliste's
   *  add row — nothing tappable underneath). `inline` pushes that content down
   *  instead, so buttons directly below the field (Prüfen's Übernehmen/Verwerfen)
   *  never end up under the list on a phone. */
  layout?: 'overlay' | 'inline';
  icon?: ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
}

/** Canonical-name typeahead: prefix matches first, then substring, most-bought
 *  first within each group. Free text stays valid everywhere — a name that
 *  doesn't exist yet is a legitimate answer (especially in Prüfen).
 *
 *  Hand-rolled on purpose. This replaced a native <datalist>, which some Android
 *  keyboards simply never rendered (no suggestions at all on a Nothing Phone,
 *  fine on a Galaxy). Do NOT swap it back for <datalist>, and keep the
 *  onMouseDown-preventDefault + delayed blur so a tap lands before the close. */
export function CanonicalCombo({
  value, onChange, onPick, placeholder, className, inputClassName,
  layout = 'overlay', icon, autoFocus, disabled,
}: Props) {
  const { t } = useTranslation();
  const { data: names } = useCanonicalNames();
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);          // keyboard-highlighted suggestion index
  const [tapShield, setTapShield] = useState(false);   // post-pick tap guard, see pick()
  const shieldTimer = useRef<number | null>(null);
  const listId = useId();
  useEffect(() => () => { if (shieldTimer.current) window.clearTimeout(shieldTimer.current); }, []);

  // Ordered by how often it's actually bought (most-bought first), so e.g.
  // Katzennassfutter beats 3D-printer filament.
  const nameOptions = useMemo(() => (names ?? []).slice().sort((a, b) =>
    (b.artikel_count ?? 0) - (a.artikel_count ?? 0) || a.canonical_name.localeCompare(b.canonical_name)), [names]);

  // Filtered typeahead: prefix matches first, then substring, most-bought order within each group.
  const suggestions = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return [] as CanonicalNameOption[];
    const pre: CanonicalNameOption[] = [], sub: CanonicalNameOption[] = [];
    for (const n of nameOptions) {
      const lc = n.canonical_name.toLowerCase();
      if (lc === q) continue;                              // no point suggesting an exact match
      if (lc.startsWith(q)) pre.push(n); else if (lc.includes(q)) sub.push(n);
    }
    return [...pre, ...sub].slice(0, 8);
  }, [value, nameOptions]);

  const show = open && suggestions.length > 0;
  const pick = (name: string) => {
    setOpen(false);
    setHi(-1);
    // Closing an `inline` list yanks everything below it up by the list's height
    // the instant the finger lifts, while the pick itself only changes text far
    // above the tap — so it reads as "nothing happened here" and invites a second
    // tap in the same spot. In Prüfen what has just moved into that spot is the
    // next card's one-tap adopt chip, which merges articles and teaches an alias
    // with no confirmation. Swallow that reflex tap on touch devices; a mouse
    // pointer stays where the user is looking, so it gets no shield.
    if (layout === 'inline' && window.matchMedia?.('(pointer: coarse)').matches) {
      if (shieldTimer.current) window.clearTimeout(shieldTimer.current);
      setTapShield(true);
      shieldTimer.current = window.setTimeout(() => setTapShield(false), 400);
    }
    (onPick ?? onChange)(name);
  };
  // An overlay floats over its surroundings, so opening it on focus costs nothing
  // (and Einkaufsliste has always done exactly that). An inline list would instead
  // shove everything below the field down before a single character is typed —
  // and Prüfen's field arrives pre-filled with the proposal, so merely tapping it
  // would pop up to 8 substring matches unasked. There, typing or ArrowDown opens.
  const onFocus = () => { if (layout === 'overlay') setOpen(true); };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!suggestions.length) return;                       // nothing to navigate — let Enter submit free text
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(h => Math.min(h + 1, suggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, -1)); }
    else if (e.key === 'Enter' && hi >= 0) {
      const sel = suggestions[hi];                         // list may have shrunk under an old index
      if (sel) { e.preventDefault(); pick(sel.canonical_name); }
    }
    else if (e.key === 'Escape') { setOpen(false); setHi(-1); }
  };

  return (
    <div className={cn('relative', className)}>
      {/* `flex` so the box hugs the icon: an absolutely positioned *inline* span
          would be as tall as the inherited line box and push the icon off-center. */}
      {icon && <span className="pointer-events-none absolute left-2.5 top-1/2 flex -translate-y-1/2 items-center text-zinc-400">{icon}</span>}
      <Input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); setHi(-1); }}
        onFocus={onFocus}
        onBlur={() => setTimeout(() => setOpen(false), 150)}   // delay so a tap on a suggestion registers first
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={inputClassName}
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={hi >= 0 && suggestions[hi] ? `${listId}-${hi}` : undefined}
      />
      {show && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('common.suggestions')}
          className={cn(
            'overflow-y-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900',
            layout === 'overlay'
              ? 'absolute left-0 right-0 top-full z-20 mt-1 max-h-64 shadow-lg'
              // Viewport-relative, because an inline list eats real estate the
              // Übernehmen/Verwerfen buttons below it need: with the keyboard up
              // (and especially in landscape) a fixed 14rem pushed them past the
              // fold — the exact problem `inline` exists to avoid.
              : 'mt-1 max-h-[min(14rem,35vh)] shadow-sm',
          )}
        >
          {suggestions.map((n, i) => (
            <button
              key={n.canonical_name}
              id={`${listId}-${i}`}
              type="button"
              role="option"
              aria-selected={i === hi}
              onMouseDown={e => e.preventDefault()}   // keep the input focused so onClick fires before blur
              onClick={() => pick(n.canonical_name)}
              className={cn('flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800', i === hi && 'bg-zinc-100 dark:bg-zinc-800')}
            >
              <span className="truncate">{n.canonical_name}</span>
              {n.artikel_count > 0 && <span className="shrink-0 text-xs text-zinc-400">{n.artikel_count}×</span>}
            </button>
          ))}
        </div>
      )}
      {/* The tap guard from pick(): invisible, no handlers — it just absorbs
          whatever lands in the first 400 ms after the list collapsed and the
          content underneath jumped. Below the modal layer (z-50) on purpose. */}
      {tapShield && <div className="fixed inset-0 z-40" aria-hidden />}
    </div>
  );
}
