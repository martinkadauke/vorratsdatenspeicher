import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tags, List, Package, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';

const TABS: { to: string; icon: LucideIcon; key: string }[] = [
  { to: 'artikel', icon: Tags, key: 'warenstamm.artikel' },
  { to: 'positionen', icon: List, key: 'warenstamm.positionen' },
  { to: 'vorrat', icon: Package, key: 'warenstamm.vorrat' },
];

/** Master-data hub: one page, three tabs (Artikel / Positionen / Vorrat). */
export function Warenstamm() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="mb-2 text-lg font-bold">{t('nav.warenstamm')}</h1>
        <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
          {TABS.map(tab => (
            <NavLink
              key={tab.to} to={tab.to}
              className={({ isActive }) => cn(
                '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition',
                isActive
                  ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200',
              )}
            >
              <tab.icon size={16} /> {t(tab.key)}
            </NavLink>
          ))}
        </div>
      </div>
      <Outlet />
    </div>
  );
}
