import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { api } from '../api/client';
import type { Category } from '../api/types';
import { Select } from './ui';
import { cn } from '../lib/utils';

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => api<Category[]>('/api/categories'),
    staleTime: 5 * 60_000,
  });
}

// Accent/case-insensitive fold so "gem" matches "Gemüse" and "Müsli".
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Typeahead search over every category (any level). Type "Gem" → Gemüse. */
function CategorySearch({ categories, onPick }: {
  categories: Category[];
  onPick: (path: string) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const byPath = useMemo(() => new Map(categories.map(c => [c.path, c] as const)), [categories]);
  const crumb = (c: Category) => {
    const parts: string[] = [];
    let p = c.parent_path;
    let guard = 0;
    while (p && guard++ < 5) {
      const parent = byPath.get(p);
      if (!parent) break;
      parts.unshift(parent.label);
      p = parent.parent_path;
    }
    return parts.join(' › ');
  };

  const matches = useMemo(() => {
    const needle = fold(q.trim());
    if (!needle) return [];
    const scored = categories
      .map(c => {
        const label = fold(c.label);
        if (label.startsWith(needle)) return { c, rank: 0 };
        if (label.includes(needle)) return { c, rank: 1 };
        if (fold(`${crumb(c)} ${c.label}`).includes(needle)) return { c, rank: 2 };
        return null;
      })
      .filter(Boolean) as { c: Category; rank: number }[];
    scored.sort((a, b) => a.rank - b.rank || a.c.label.localeCompare(b.c.label));
    return scored.slice(0, 25).map(s => s.c);
  }, [q, categories]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const choose = (c: Category) => {
    onPick(c.path);
    setQ('');
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
      <input
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => q && setOpen(true)}
        onKeyDown={e => {
          if (!open || matches.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); choose(matches[active]); }
          else if (e.key === 'Escape') { setOpen(false); }
        }}
        placeholder="Kategorie suchen… (z.B. Gem)"
        className="w-full rounded-lg border border-zinc-200 bg-white py-2 pl-8 pr-8 text-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:ring-emerald-900/40"
      />
      {q && (
        <button type="button" onClick={() => { setQ(''); setOpen(false); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600">
          <X className="h-4 w-4" />
        </button>
      )}
      {open && matches.length > 0 && (
        <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {matches.map((c, i) => {
            const bc = crumb(c);
            return (
              <li key={c.path}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(c)}
                  className={cn(
                    'flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm',
                    i === active ? 'bg-emerald-50 dark:bg-emerald-950/40' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                  )}
                >
                  <span className="truncate">{c.emoji ? `${c.emoji} ` : ''}{c.label}</span>
                  {bc && <span className="ml-auto shrink-0 truncate text-xs text-zinc-400">{bc}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Cascading 3-level category dropdown with a typeahead search. value = full path or null. */
export function CategoryPicker({ value, onChange }: {
  value: string | null;
  onChange: (path: string | null) => void;
}) {
  const { data: categories = [] } = useCategories();

  const roots = useMemo(() => categories.filter(c => c.level === 1), [categories]);
  const parts = (value ?? '').split('/');
  const l1 = parts[0] || '';
  const l2 = parts.length >= 2 ? parts.slice(0, 2).join('/') : '';
  const l3 = parts.length >= 3 ? value! : '';

  const children = (parent: string) => categories.filter(c => c.parent_path === parent);
  const l2opts = l1 ? children(l1) : [];
  const l3opts = l2 ? children(l2) : [];

  const pick = (path: string) => {
    onChange(path || null);
  };

  return (
    <div className="flex flex-col gap-2">
      <CategorySearch categories={categories} onPick={pick} />
      <Select value={l1} onChange={e => pick(e.target.value)}>
        <option value="">–</option>
        {roots.map(c => (
          <option key={c.path} value={c.path}>{c.emoji ? `${c.emoji} ` : ''}{c.label}</option>
        ))}
      </Select>
      {l2opts.length > 0 && (
        <Select value={l2} onChange={e => pick(e.target.value || l1)}>
          <option value="">–</option>
          {l2opts.map(c => (
            <option key={c.path} value={c.path}>{c.label}</option>
          ))}
        </Select>
      )}
      {l3opts.length > 0 && (
        <Select value={l3} onChange={e => pick(e.target.value || l2)}>
          <option value="">–</option>
          {l3opts.map(c => (
            <option key={c.path} value={c.path}>{c.label}</option>
          ))}
        </Select>
      )}
    </div>
  );
}
