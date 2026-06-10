import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Category } from '../api/types';
import { Select } from './ui';

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => api<Category[]>('/api/categories'),
    staleTime: 5 * 60_000,
  });
}

/** Cascading 3-level category dropdown. value = full path or null. */
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
