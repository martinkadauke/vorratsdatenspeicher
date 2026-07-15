import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ClipboardList, BadgePercent, Store, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';

const TABS: { to: string; icon: LucideIcon; key: string }[] = [
  { to: 'list', icon: ClipboardList, key: 'nav.shopping' }, // Liste (default)
  { to: 'offers', icon: BadgePercent, key: 'nav.offers' },  // Angebote
  { to: 'stores', icon: Store, key: 'nav.stores' },         // Läden
];

/** Shopping hub: one page, three tabs (Liste / Angebote / Läden) — mirrors the Warenstamm
 *  master-data hub. The list is the default tab. */
export function ShoppingHub() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="mb-2 text-lg font-bold">{t('nav.einkauf')}</h1>
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
            </NavLink>
          ))}
        </div>
      </div>
      <Outlet />
    </div>
  );
}
