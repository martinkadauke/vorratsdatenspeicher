import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { LogOut, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/auth';
import { setLanguage } from '../i18n';
import { Card, Button, Input, Label, Select, Switch } from '../components/ui';

export function Profile() {
  const { t } = useTranslation();
  const { user, logout, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwSaved, setPwSaved] = useState(false);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/api/me', { method: 'PATCH', body }),
    onSuccess: () => void refreshUser(),
  });

  const changePw = useMutation({
    mutationFn: () => api('/api/me', { method: 'PATCH', body: { old_password: oldPw, password: newPw } }),
    onSuccess: () => { setOldPw(''); setNewPw(''); setPwSaved(true); setTimeout(() => setPwSaved(false), 3000); },
  });

  if (!user) return null;

  return (
    <div className="flex max-w-md flex-col gap-4">
      <h1 className="text-lg font-bold">{t('profile.title')}</h1>

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-xl font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
            {user.username[0]?.toUpperCase()}
          </div>
          <div>
            <div className="font-semibold">{user.username}</div>
            {user.is_admin && <div className="text-xs text-emerald-600 dark:text-emerald-500">Admin</div>}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t('profile.darkMode')}</span>
          <Switch
            checked={user.prefers_dark}
            onChange={v => {
              document.documentElement.classList.toggle('dark', v);
              patch.mutate({ prefers_dark: v });
            }}
          />
        </div>

        <div>
          <Label>{t('profile.language')}</Label>
          <Select
            value={user.preferred_lang}
            onChange={e => {
              setLanguage(e.target.value);
              patch.mutate({ preferred_lang: e.target.value });
            }}
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </Select>
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">{t('profile.changePw')}</h2>
        <div>
          <Label>{t('profile.oldPw')}</Label>
          <Input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} />
        </div>
        <div>
          <Label>{t('profile.newPw')}</Label>
          <Input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} />
        </div>
        {changePw.isError && <p className="text-sm text-red-500">{(changePw.error as Error).message}</p>}
        {pwSaved && <p className="text-sm text-emerald-600">{t('profile.saved')}</p>}
        <Button onClick={() => changePw.mutate()} disabled={!oldPw || !newPw || changePw.isPending}>
          {t('common.save')}
        </Button>
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-base font-semibold">{t('profile.helpHeading')}</h2>
        <Button
          variant="secondary"
          onClick={() => window.dispatchEvent(new Event('vds:open-tour'))}
        >
          <Sparkles size={14} /> {t('profile.replayTour')}
        </Button>
      </Card>

      <Button variant="secondary" onClick={() => { logout(); navigate('/login'); }}>
        <LogOut size={16} /> {t('nav.logout')}
      </Button>
    </div>
  );
}
