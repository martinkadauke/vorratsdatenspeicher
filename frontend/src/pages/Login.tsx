import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/auth';
import { Button, Input, Label, Card } from '../components/ui';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(false);
    try {
      await login(username, password);
      navigate('/receipts');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 text-center">
          <div className="text-4xl">🗄️</div>
          <h1 className="mt-2 text-xl font-bold tracking-tight">{t('login.title')}</h1>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <Label>{t('login.username')}</Label>
            <Input value={username} onChange={e => setUsername(e.target.value)} autoFocus autoCapitalize="none" />
          </div>
          <div>
            <Label>{t('login.password')}</Label>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          {error && <p className="text-sm text-red-500">{t('login.error')}</p>}
          <Button type="submit" disabled={busy || !username || !password}>
            {t('login.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
