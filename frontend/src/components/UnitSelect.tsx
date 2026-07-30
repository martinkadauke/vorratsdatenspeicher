import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useAuth } from '../context/auth';
import { toast } from './Toast';
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
  const { user, demo } = useAuth();
  const { data: units } = useQuery({
    queryKey: ['units'],
    queryFn: () => api<Unit[]>('/api/units'),
    staleTime: 5 * 60_000,
  });
  const list = units ?? [];
  const v = value ?? '';
  const knownValue = !v || list.some(u => u.name === v);
  // `unit` is a PLATFORM-GLOBAL catalogue (no household_id), so POST /api/units is
  // requireOperator — mirror that predicate here instead of offering everyone an option that
  // can only 403. Off-demo it is plain is_admin, so a self-hoster's admin still sees it and a
  // read-only member (who could never add one anyway) no longer does.
  const canAddUnit = demo ? !!user?.is_super_admin : !!user?.is_admin;

  const addNew = async () => {
    const name = (window.prompt(t('units.addPrompt')) ?? '').trim();
    if (!name) return;
    try {
      await api('/api/units', { method: 'POST', body: { name } });
      await qc.invalidateQueries({ queryKey: ['units'] });
      onChange(name);
    } catch (e) {
      // Never swallow this: the select snaps back to its old value, so without a message the
      // app just looks broken (the old empty catch was written for the 403 now gated above).
      toast((e as Error).message, 'error');
    }
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
      {canAddUnit && <option value="__new__">{t('units.addNew')}</option>}
    </Select>
  );
}
