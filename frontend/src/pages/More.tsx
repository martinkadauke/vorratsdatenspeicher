import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, LogOut } from 'lucide-react';
import { useAuth } from '../context/auth';
import { Card, Button } from '../components/ui';
import { NAV, MOBILE_PRIMARY, navExtras } from '../lib/nav';

export function More() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // Everything not in the mobile bottom bar: the rest of NAV, then admin + profile.
  const items = [...NAV.slice(MOBILE_PRIMARY), ...navExtras(!!user?.is_admin)];

  return (
    <div className="flex flex-col gap-2">
      {items.map(({ to, icon: Icon, key }) => (
        <Link key={to} to={to}>
          <Card className="flex items-center gap-3 p-4">
            <Icon size={20} className="text-zinc-400" />
            <span className="flex-1 font-medium">{t(key)}</span>
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
