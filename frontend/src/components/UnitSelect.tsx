import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { Select } from './ui';

interface Unit { name: string; dimension: string; to_base: number; sort_order: number; builtin: boolean }

/** Dropdown over the managed unit list (/api/units). Picking "+ neue Einheit…"
 *  prompts for a name and adds it (count dimension by default). The current
 *  value is always selectable even if it isn't (yet) in the list, so legacy
 *  free-text units from OCR still show. */
export function UnitSelect({ value, onChange, allowEmpty = true, className }: {
  value: string | null;
  onChange: (v: string | null) => void;
  allowEmpty?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: units } = useQuery({
    queryKey: ['units'],
    queryFn: () => api<Unit[]>('/api/units'),
    staleTime: 5 * 60_000,
  });
  const list = units ?? [];
  const v = value ?? '';
  const knownValue = !v || list.some(u => u.name === v);

  const addNew = async () => {
    const name = (window.prompt(t('units.addPrompt')) ?? '').trim();
    if (!name) return;
    try {
      await api('/api/units', { method: 'POST', body: { name } });
      await qc.invalidateQueries({ queryKey: ['units'] });
      onChange(name);
    } catch { /* ignore (e.g. not admin) */ }
  };

  return (
    <Select
      className={className}
      value={v}
      onChange={e => {
        if (e.target.value === '__new__') { void addNew(); return; }
        onChange(e.target.value || null);
      }}
    >
      {allowEmpty && <option value="">—</option>}
      {!knownValue && <option value={v}>{v}</option>}
      {list.map(u => <option key={u.name} value={u.name}>{u.name}</option>)}
      <option value="__new__">{t('units.addNew')}</option>
    </Select>
  );
}
