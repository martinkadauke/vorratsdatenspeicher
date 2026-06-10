import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { Button, Input, Label, Card, Spinner } from '../components/ui';

interface TokenInfo { valid: boolean; kind?: 'invite' | 'reset'; username?: string }

export function Reset() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<TokenInfo>(`/api/auth/token-info?token=${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch(() => setInfo({ valid: false }));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError(t('reset.mismatch')); return; }
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/reset', { method: 'POST', body: { token, password } });
      navigate('/login', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (info === null) return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 text-center">
          <div className="text-4xl">🗄️</div>
          <h1 className="mt-2 text-xl font-bold tracking-tight">
            {info.kind === 'invite' ? t('reset.welcomeTitle') : t('reset.title')}
          </h1>
          {info.valid && info.username && (
            <p className="mt-1 text-sm text-zinc-500">
              {info.kind === 'invite' ? t('reset.welcomeText', { name: info.username }) : info.username}
            </p>
          )}
        </div>

        {!info.valid ? (
          <p className="text-center text-sm text-red-500">{t('reset.invalid')}</p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <Label>{t('reset.newPassword')}</Label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
            </div>
            <div>
              <Label>{t('reset.confirm')}</Label>
              <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button type="submit" disabled={busy || password.length < 8 || !confirm}>
              {t('reset.submit')}
            </Button>
            {password.length > 0 && password.length < 8 && (
              <p className="text-xs text-zinc-400">{t('reset.tooShort')}</p>
            )}
          </form>
        )}
      </Card>
    </div>
  );
}
