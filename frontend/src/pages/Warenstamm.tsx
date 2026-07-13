import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Tags, List, Package, ClipboardCheck, type LucideIcon } from 'lucide-react';
import { api } from '../api/client';
import { cn } from '../lib/utils';

const TABS: { to: string; icon: LucideIcon; key: string }[] = [
  { to: 'artikel', icon: Tags, key: 'warenstamm.artikel' },
  { to: 'positionen', icon: List, key: 'warenstamm.positionen' },
  { to: 'vorrat', icon: Package, key: 'warenstamm.vorrat' },
  { to: 'pruefen', icon: ClipboardCheck, key: 'warenstamm.pruefen' },
];

/** Master-data hub: one page, four tabs (Artikel / Positionen / Vorrat / Prüfen).
 *  Prüfen is where the user reviews whether articles & positions were set correctly. */
export function Warenstamm() {
  const { t } = useTranslation();
  // Pending-review count, shown as a badge on the Prüfen tab (cached key shared with the nav).
  const { data: pruefen } = useQuery({
    queryKey: ['pruefen-count'],
    queryFn: () => api<{ count: number }>('/api/pruefen/count'),
    refetchInterval: 60000,
    staleTime: 30000,
  });
  const pruefenCount = pruefen?.count ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="mb-2 text-lg font-bold">{t('nav.warenstamm')}</h1>
        {/* Equal-width flex tabs: they always fill the row exactly, and long labels
            truncate rather than push the bar into a horizontal scroll. */}
        <div className="flex items-stretch border-b border-zinc-200 dark:border-zinc-800">
          {TABS.map(tab => (
            <NavLink
              key={tab.to} to={tab.to}
              className={({ isActive }) => cn(
                '-mb-px flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-2 text-xs font-medium transition sm:gap-2 sm:px-3 sm:text-sm',
                isActive
                  ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
              )}
            >
              <tab.icon size={16} className="shrink-0" />
              <span className="min-w-0 truncate">{t(tab.key)}</span>
              {tab.to === 'pruefen' && pruefenCount > 0 && (
                <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold leading-none text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                  {pruefenCount}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      </div>
      <Outlet />
    </div>
  );
}
