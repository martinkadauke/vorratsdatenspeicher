import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ReceiptText, UserCircle, LogOut, Eye, Settings } from 'lucide-react';
import { useAuth } from '../context/auth';
import { api } from '../api/client';
import { NotificationBell } from './NotificationBell';
import { Tour } from './Tour';
import { Onboarding } from './Onboarding';
import { Coach } from './Coach';
import { Toaster } from './Toast';
import { ConfirmHost } from './Confirm';
import { cn } from '../lib/utils';
import { NAV, MOBILE_PRIMARY, navExtras, mobileTail } from '../lib/nav';
import { BugReportButton } from './BugReportButton';
import { RecommendButton } from './RecommendButton';
import { InstallButton } from './InstallButton';
import { UpdateBanner } from './UpdateBanner';

/** Colour-coded environment badge keyed on the runtime VDS_ENV (prod/stage/dev),
 *  which is reliable even when branches share a commit SHA. Unknown → no badge. */
const ENV_BADGE: Record<string, { label: string; cls: string }> = {
  prod: { label: 'prod', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400' },
  stage: { label: 'stage', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400' },
  dev: { label: 'dev', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400' },
};

export function Layout() {
  const { t } = useTranslation();
  const { user, logout, demo } = useAuth();
  const navigate = useNavigate();
  const [tourOpen, setTourOpen] = useState(false);

  // Which environment are we on? Use the runtime VDS_ENV (prod/stage/dev) — NOT
  // the git ref, which collides across branches that share a commit SHA.
  const { data: version } = useQuery({
    queryKey: ['version'],
    queryFn: () => api<{ ref: string; env: string | null }>('/api/version'),
    staleTime: Infinity,
  });
  const envBadge = version?.env ? ENV_BADGE[version.env] : undefined;

  // Live count of articles awaiting a decision, shown as a badge on the Prüfung nav.
  const { data: pruefen } = useQuery({
    queryKey: ['pruefen-count'],
    queryFn: () => api<{ count: number }>('/api/pruefen/count'),
    refetchInterval: 60000,
    staleTime: 30000,
  });
  const pruefenCount = pruefen?.count ?? 0;

  // Auto-open tour on first login (after a tiny delay so the UI has settled).
  // Suppressed while the admin first-run onboarding wizard is still pending — setup
  // comes before the feature tour, then the tour opens once onboarding is done.
  useEffect(() => {
    const onboardingPending = user?.is_admin && user?.onboarding_done === false;
    if (user && user.has_seen_tour === false && !onboardingPending) {
      const id = window.setTimeout(() => setTourOpen(true), 400);
      return () => window.clearTimeout(id);
    }
  }, [user?.has_seen_tour, user?.onboarding_done, user?.is_admin]);

  // Allow Profile page to re-open the tour via custom event
  useEffect(() => {
    const open = () => setTourOpen(true);
    window.addEventListener('vds:open-tour', open);
    return () => window.removeEventListener('vds:open-tour', open);
  }, []);

  // Is this the platform operator? Same predicate as the backend's requireOperator and the
  // Admin page's `operatorOnly`: on the demo every visitor is is_admin of their own household,
  // so only is_super_admin distinguishes the operator there.
  const isOperator = demo ? !!user?.is_super_admin : !!user?.is_admin;
  // Fifth bottom-bar slot — Admin for the operator, Profil for everyone else.
  const tail = mobileTail(isOperator);
  // A demo household admin gets Profil in the bar (above) but still has real household
  // settings on /admin — Konten, Familie, Nutzer, Kategorien. The sidebar that carries that
  // link is md:flex, so on a phone the page would have no entry point at all: give them a
  // gear in the header. Hidden for the operator, whose bottom bar already leads there.
  const showAdminShortcut = !!user?.is_admin && !isOperator;

  const navItem = (to: string, Icon: typeof ReceiptText, label: string, mobile = false, badge = 0) => (
    <NavLink
      key={to}
      to={to}
      className={({ isActive }) =>
        cn(
          mobile
            ? 'relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium'
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
      {badge > 0 && (
        <span className={cn(
          'rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold leading-none text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400',
          mobile ? 'absolute right-3 top-1' : 'ml-auto',
        )}>
          {badge}
        </span>
      )}
    </NavLink>
  );

  return (
    <div className="min-h-dvh overflow-x-clip">
      {/* Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-200 bg-white/80 px-3 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80 sm:px-4">
        <NavLink to="/receipts" className="flex items-center gap-2 text-base font-bold tracking-tight">
          {/* icon-192, not icon.png: the latter is the same artwork at 512px/33 kB and was
              being downloaded in full on every page load to fill a 28px box. */}
          <img src="/icon-192.png" alt="" className="h-7 w-7 rounded-md" />
          <span>Vorratsdatenspeicher</span>
          {envBadge && (
            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide', envBadge.cls)}>
              {envBadge.label}
            </span>
          )}
        </NavLink>
        <div className="flex items-center gap-1">
          <RecommendButton />
          <BugReportButton variant="header" />
          <NotificationBell />
          {showAdminShortcut && (
            <NavLink
              to="/admin" title={t('nav.admin')} aria-label={t('nav.admin')}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 md:hidden"
            >
              <Settings size={20} />
            </NavLink>
          )}
          <NavLink
            to="/profile" title={user?.username}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-xl leading-none text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            {user?.emoji ? <span aria-hidden>{user.emoji}</span> : <UserCircle size={20} />}
          </NavLink>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl">
        {/* Desktop sidebar */}
        <aside className="sticky top-[53px] hidden h-[calc(100dvh-53px)] w-52 shrink-0 flex-col gap-1 overflow-y-auto p-3 md:flex">
          {NAV.map(n => navItem(n.to, n.icon, t(n.key), false, n.to === '/warenstamm' ? pruefenCount : 0))}
          {navExtras(!!user?.is_admin).map(n => navItem(n.to, n.icon, t(n.key)))}
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
          <UpdateBanner />
          {user && user.can_write === false && !user.is_admin && (
            <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-300">
              <Eye size={16} className="shrink-0" />
              <span>{t('common.readOnlyBanner')}</span>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav: the four NAV items + one tail slot (Admin for the operator,
          otherwise Profil). The operator reaches Profil via the header avatar; a demo
          household admin reaches Admin via the header gear. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-zinc-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95 md:hidden">
        {NAV.slice(0, MOBILE_PRIMARY).map(n => navItem(n.to, n.icon, t(n.key), true, n.to === '/warenstamm' ? pruefenCount : 0))}
        {navItem(tail.to, tail.icon, t(tail.key), true)}
      </nav>

      {/* Demo-only floating CTAs: "Get VDS" install guide + a bug-report button on every page. */}
      {demo && <><InstallButton /><BugReportButton /></>}
      <Onboarding />
      <Coach />
      <Tour open={tourOpen} onClose={() => setTourOpen(false)} />
      <Toaster />
      <ConfirmHost />
    </div>
  );
}
