import { useTranslation } from 'react-i18next';
import { Target, Construction } from 'lucide-react';
import { Card } from '../components/ui';

/** Placeholder for the upcoming "Ziele" (goals) section. WIP. */
export function Ziele() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Target size={20} className="text-emerald-500" />
        <h1 className="text-lg font-bold">{t('nav.ziele')}</h1>
      </div>
      <Card className="flex items-center gap-3 p-4">
        <Construction size={22} className="shrink-0 text-amber-500" />
        <div>
          <div className="text-sm font-medium">{t('ziele.wipTitle')}</div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('ziele.wipBody')}</p>
        </div>
      </Card>
    </div>
  );
}
