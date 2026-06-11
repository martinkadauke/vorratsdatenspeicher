import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/auth';
import { api, ApiError } from '../api/client';
import { Button, Input, Label, Card } from '../components/ui';

interface VersionInfo { sha: string; ref: string }

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<'' | 'credentials' | 'network'>('');
  const [busy, setBusy] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [email, setEmail] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    api<VersionInfo>('/api/version').then(setVersion).catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
      navigate('/receipts');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'credentials' : 'network');
    } finally {
      setBusy(false);
    }
  };

  const submitForgot = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/auth/forgot', { method: 'POST', body: { email } });
      setForgotSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="relative w-full max-w-sm p-6">
        {version && version.sha !== 'unknown' && (
          <div className="absolute bottom-1.5 right-3 text-[10px] text-zinc-300 dark:text-zinc-600 tabular">
            {version.ref}@{version.sha.slice(0, 7)}
          </div>
        )}
        <div className="mb-6 text-center">
          <div className="text-4xl">🗄️</div>
          <h1 className="mt-2 text-xl font-bold tracking-tight">{t('login.title')}</h1>
        </div>

        {forgotMode ? (
          forgotSent ? (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-zinc-500">{t('login.forgotSent')}</p>
              <Button variant="secondary" onClick={() => { setForgotMode(false); setForgotSent(false); }}>
                {t('login.backToLogin')}
              </Button>
            </div>
          ) : (
            <form onSubmit={submitForgot} className="flex flex-col gap-4">
              <div>
                <Label>{t('login.email')}</Label>
                <Input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus />
              </div>
              <Button type="submit" disabled={busy || !email}>{t('login.sendReset')}</Button>
              <button type="button" onClick={() => setForgotMode(false)} className="text-xs text-zinc-400 hover:underline">
                {t('login.backToLogin')}
              </button>
            </form>
          )
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <Label>{t('login.username')}</Label>
              <Input value={username} onChange={e => setUsername(e.target.value)} autoFocus autoCapitalize="none" />
            </div>
            <div>
              <Label>{t('login.password')}</Label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            {error && (
              <p className="text-sm text-red-500">
                {error === 'credentials' ? t('login.error') : t('login.errorNetwork')}
              </p>
            )}
            <Button type="submit" disabled={busy || !username || !password}>
              {t('login.submit')}
            </Button>
            <button type="button" onClick={() => setForgotMode(true)} className="text-xs text-zinc-400 hover:underline">
              {t('login.forgot')}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}
