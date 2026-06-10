import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tags, ListChecks, Settings, UserCircle, ChevronRight } from 'lucide-react';
import { useAuth } from '../context/auth';
import { Card } from '../components/ui';

export function More() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const items = [
    { to: '/names', icon: Tags, label: t('nav.names') },
    { to: '/queue', icon: ListChecks, label: t('nav.queue') },
    ...(user?.is_admin ? [{ to: '/admin', icon: Settings, label: t('nav.admin') }] : []),
    { to: '/profile', icon: UserCircle, label: t('nav.profile') },
  ];

  return (
    <div className="flex flex-col gap-2">
      {items.map(({ to, icon: Icon, label }) => (
        <Link key={to} to={to}>
          <Card className="flex items-center gap-3 p-4">
            <Icon size={20} className="text-zinc-400" />
            <span className="flex-1 font-medium">{label}</span>
            <ChevronRight size={18} className="text-zinc-300" />
          </Card>
        </Link>
      ))}
    </div>
  );
}
