import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { FamilyMember } from '../api/types';
import { cn } from '../lib/utils';
import { Switch } from './ui';

export function useFamily() {
  return useQuery({
    queryKey: ['family'],
    queryFn: () => api<FamilyMember[]>('/api/family'),
    staleTime: 5 * 60_000,
  });
}

/** Multi-select family member chips with optional exclusive toggle. */
export function ConsumerChips({ selected, onChange, exclusive, onExclusiveChange }: {
  selected: number[];
  onChange: (ids: number[]) => void;
  exclusive?: boolean;
  onExclusiveChange?: (v: boolean) => void;
}) {
  const { data: members = [] } = useFamily();
  const { t } = useTranslation();

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id]);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {members.map(m => {
          const active = selected.includes(m.id);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-sm font-medium transition-colors',
                active
                  ? 'border-transparent text-white'
                  : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300',
              )}
              style={active ? { backgroundColor: m.color ?? '#10b981' } : undefined}
            >
              {m.emoji ? `${m.emoji} ` : ''}{m.name}
            </button>
          );
        })}
      </div>
      {onExclusiveChange && selected.length > 0 && (
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Switch checked={exclusive ?? false} onChange={onExclusiveChange} />
          {t('article.exclusive')}
        </div>
      )}
    </div>
  );
}

/** Small read-only dots showing who consumes an item. */
export function ConsumerDots({ ids }: { ids: number[] }) {
  const { data: members = [] } = useFamily();
  if (!ids.length) return null;
  return (
    <span className="inline-flex items-center gap-0.5">
      {ids.map(id => {
        const m = members.find(x => x.id === id);
        if (!m) return null;
        return (
          <span
            key={id}
            title={m.name}
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: m.color ?? '#10b981' }}
          />
        );
      })}
    </span>
  );
}
