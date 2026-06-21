import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, LogOut } from 'lucide-react';
import { useAuth } from '../context/auth';
import { api } from '../api/client';
import { Card, Button } from '../components/ui';
import { NAV, MOBILE_PRIMARY, navExtras } from '../lib/nav';

export function More() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // Everything not in the mobile bottom bar: the rest of NAV, then admin + profile.
  const items = [...NAV.slice(MOBILE_PRIMARY), ...navExtras(!!user?.is_admin)];

  const { data: pruefen } = useQuery({
    queryKey: ['pruefen-count'],
    queryFn: () => api<{ count: number }>('/api/pruefen/count'),
    staleTime: 30000,
  });
  const pruefenCount = pruefen?.count ?? 0;

  return (
    <div className="flex flex-col gap-2">
      {items.map(({ to, icon: Icon, key }) => (
        <Link key={to} to={to}>
          <Card className="flex items-center gap-3 p-4">
            <Icon size={20} className="text-zinc-400" />
            <span className="flex-1 font-medium">{t(key)}</span>
            {to === '/queue' && pruefenCount > 0 && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                {pruefenCount}
              </span>
            )}
            <ChevronRight size={18} className="text-zinc-300" />
          </Card>
        </Link>
      ))}
      <Button variant="secondary" className="mt-2" onClick={() => { logout(); navigate('/login'); }}>
        <LogOut size={16} /> {t('nav.logout')}
      </Button>
    </div>
  );
}
