import { useState, type FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, setToken } from '../api/client';
import { useAuth } from '../context/auth';
import { Button, Input, Label, Card, Spinner } from '../components/ui';

/** The invited person's page — public, reached through the link the admin shared.
 *
 *  They create their OWN account here: the admin never learns the e-mail and never picks the
 *  password. The link alone is not enough; the four digits come through a second channel (spoken,
 *  called, sent separately), which is what makes an intercepted link useless.
 *
 *  It greets by household-member name, because that is the one thing the link may safely reveal
 *  and it is what tells the invitee they are in the right place. */
export function Einladung() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();

  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<{ valid: boolean; member?: string; reason?: string }>(`/api/invite/${token}`),
    enabled: !!token,
    retry: false,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token: string }>(`/api/invite/${token}/redeem`, {
        method: 'POST', body: { code, username: username.trim(), password, email: email.trim() || undefined },
      });
      setToken(res.token);
      await refreshUser();
      navigate('/receipts');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : '';
      setError(
        msg === 'wrong_code' ? t('invite.wrongCode')
        : msg === 'locked' ? t('invite.locked')
        : msg === 'expired' ? t('invite.expired')
        : msg === 'username_taken' ? t('invite.nameTaken')
        : t('invite.failed'),
      );
    } finally { setBusy(false); }
  };

  if (isLoading) {
    return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;
  }

  // Expired, spent, or guessed at five times — all the same to the invitee: ask the admin again.
  if (!data?.valid) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm p-6 text-center">
          <img src="/icon-192.png" alt="" className="mx-auto mb-4 h-14 w-14 rounded-2xl" />
          <h1 className="mb-2 text-lg font-bold">{t('invite.deadTitle')}</h1>
          <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{t('invite.deadBody')}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm p-6">
        <img src="/icon-192.png" alt="" className="mx-auto mb-4 h-14 w-14 rounded-2xl" />
        <h1 className="mb-1 text-center text-lg font-bold">{t('invite.hello', { name: data.member })}</h1>
        <p className="mb-5 text-center text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{t('invite.intro')}</p>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <Label>{t('invite.code')}</Label>
            <Input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
              inputMode="numeric" autoComplete="one-time-code" placeholder="1234" autoFocus
              className="text-center font-mono text-lg tracking-[0.4em]" />
            <p className="mt-1 text-[11px] text-zinc-400">{t('invite.codeHint')}</p>
          </div>
          <div>
            <Label>{t('invite.username')}</Label>
            <Input value={username} onChange={e => setUsername(e.target.value)} autoCapitalize="none" />
          </div>
          <div>
            <Label>{t('invite.password')}</Label>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
          </div>
          <div>
            <Label>{t('invite.email')}</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
            <p className="mt-1 text-[11px] text-zinc-400">{t('invite.emailHint')}</p>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button type="submit" disabled={busy || code.length !== 4 || !username.trim() || password.length < 8}>
            {busy ? '…' : t('invite.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
