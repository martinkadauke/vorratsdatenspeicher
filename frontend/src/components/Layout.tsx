import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ReceiptText, ChartPie, ShoppingCart, Package, Tags, ListChecks, Store,
  Settings, UserCircle, LogOut, MoreHorizontal,
} from 'lucide-react';
import { useAuth } from '../context/auth';
import { NotificationBell } from './NotificationBell';
import { Tour } from './Tour';
import { cn } from '../lib/utils';

const NAV = [
  { to: '/receipts', icon: ReceiptText, key: 'nav.receipts' },
  { to: '/stats', icon: ChartPie, key: 'nav.stats' },
  { to: '/shopping', icon: ShoppingCart, key: 'nav.shopping' },
  { to: '/pantry', icon: Package, key: 'nav.pantry' },
  { to: '/names', icon: Tags, key: 'nav.names' },
  { to: '/stores', icon: Store, key: 'nav.stores' },
  { to: '/queue', icon: ListChecks, key: 'nav.queue' },
] as const;

export function Layout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [tourOpen, setTourOpen] = useState(false);

  // Auto-open tour on first login (after a tiny delay so the UI has settled)
  useEffect(() => {
    if (user && user.has_seen_tour === false) {
      const id = window.setTimeout(() => setTourOpen(true), 400);
      return () => window.clearTimeout(id);
    }
  }, [user?.has_seen_tour]);

  // Allow Profile page to re-open the tour via custom event
  useEffect(() => {
    const open = () => setTourOpen(true);
    window.addEventListener('vds:open-tour', open);
    return () => window.removeEventListener('vds:open-tour', open);
  }, []);

  const navItem = (to: string, Icon: typeof ReceiptText, label: string, mobile = false) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) =>
        cn(
          mobile
            ? 'flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium'
            : 'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium',
          isActive
            ? 'text-emerald-600 dark:text-emerald-500'
            : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
          !mobile && 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
        )
      }
    >
      <Icon size={mobile ? 22 : 18} />
      <span>{label}</span>
    </NavLink>
  );

  return (
    <div className="min-h-dvh overflow-x-clip">
      {/* Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-200 bg-white/80 px-3 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80 sm:px-4">
        <NavLink to="/receipts" className="flex items-center gap-2 text-base font-bold tracking-tight">
          <span className="text-xl">🗄️</span>
          <span>Vorratsdatenspeicher</span>
        </NavLink>
        <div className="flex items-center gap-1">
          <NotificationBell />
          <NavLink to="/profile" className="rounded-xl p-2 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">
            <UserCircle size={20} />
          </NavLink>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl">
        {/* Desktop sidebar */}
        <aside className="sticky top-[53px] hidden h-[calc(100dvh-53px)] w-52 shrink-0 flex-col gap-1 overflow-y-auto p-3 md:flex">
          {NAV.map(n => navItem(n.to, n.icon, t(n.key)))}
          {user?.is_admin && navItem('/admin', Settings, t('nav.admin'))}
          <div className="mt-auto">
            <button
              onClick={() => { logout(); navigate('/login'); }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <LogOut size={18} />
              {t('nav.logout')}
            </button>
          </div>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1 p-3 pb-24 sm:p-4 md:pb-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-zinc-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95 md:hidden">
        {NAV.slice(0, 4).map(n => navItem(n.to, n.icon, t(n.key), true))}
        {navItem('/more', MoreHorizontal, t('nav.more'), true)}
      </nav>

      <Tour open={tourOpen} onClose={() => setTourOpen(false)} />
    </div>
  );
}
