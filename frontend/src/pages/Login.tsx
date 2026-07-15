import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/auth';
import { api, ApiError } from '../api/client';
import { Button, Input, Label, Card, Spinner } from '../components/ui';

interface VersionInfo { sha: string; ref: string; demo?: boolean }

export function Login() {
  const { login, signup } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const de = i18n.language.startsWith('de');

  // Resolve the version (and its demo flag) before choosing a mode, so the demo
  // signup-first flow never flashes the plain login form (or vice-versa).
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const demo = !!version?.demo;

  // Demo: ~all traffic is first-time visitors, so open on sign-up (create household);
  // logging in is the rare, secondary path. Off-demo: classic login.
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [household, setHousehold] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  useEffect(() => {
    api<VersionInfo>('/api/version')
      .then(v => { setVersion(v); if (v.demo) setMode('signup'); })
      .catch(() => setVersion({ sha: 'unknown', ref: 'unknown' }));
  }, []);

  const switchMode = (m: 'login' | 'signup') => { setMode(m); setError(''); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
      navigate('/receipts');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('login.error') : t('login.errorNetwork'));
    } finally {
      setBusy(false);
    }
  };

  const submitSignup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signup(email, password, household);
      navigate('/receipts');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(de ? 'Diese E-Mail ist bereits registriert.' : 'That email is already registered.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError(de ? 'Bitte eine gültige E-Mail und ein Passwort (min. 8 Zeichen) angeben.' : 'Enter a valid email and a password (min. 8 characters).');
      } else {
        setError(t('login.errorNetwork'));
      }
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

  if (version === null) {
    return <div className="flex min-h-dvh items-center justify-center"><Spinner /></div>;
  }

  const versionBadge = version.sha !== 'unknown' && (
    <div className="absolute bottom-1.5 right-3 text-[10px] text-zinc-300 dark:text-zinc-600 tabular">
      {version.ref}@{version.sha.slice(0, 7)}
    </div>
  );

  // ── DEMO: signup-first, no password recovery (households are wiped nightly) ──
  if (demo) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="relative w-full max-w-sm p-6 sm:p-7">
          {versionBadge}
          <div className="mb-6 text-center">
            <div className="text-5xl">🗄️</div>
            <h1 className="mt-3 text-2xl font-bold tracking-tight">{t('login.title')}</h1>
            {mode === 'signup' ? (
              <p className="mx-auto mt-2 max-w-[16rem] text-[15px] leading-snug text-zinc-600 dark:text-zinc-300">
                {de
                  ? 'Leg in Sekunden deinen eigenen Haushalt an und probier alles aus.'
                  : 'Create your own household in seconds and try everything out.'}
                <span className="mt-2 block rounded-lg bg-amber-100 px-2.5 py-1.5 text-[13px] font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                  {de
                    ? '⚠️ Nur eine Demo — alles wird heute um Mitternacht garantiert komplett gelöscht.'
                    : '⚠️ Just a demo — everything is 100% wiped tonight at midnight.'}
                </span>
              </p>
            ) : (
              <p className="mt-2 text-sm text-zinc-500">{de ? 'Willkommen zurück.' : 'Welcome back.'}</p>
            )}
          </div>

          {mode === 'signup' ? (
            <form onSubmit={submitSignup} className="flex flex-col gap-4">
              <div>
                <Label>{de ? 'Haushaltsname' : 'Household name'}</Label>
                <Input value={household} onChange={e => setHousehold(e.target.value)} autoFocus placeholder={de ? 'z. B. Familie Müller' : 'e.g. The Smiths'} />
              </div>
              <div>
                <Label>{t('login.email')}</Label>
                <Input type="email" value={email} onChange={e => setEmail(e.target.value)} autoCapitalize="none" />
              </div>
              <div>
                <Label>{t('login.password')}</Label>
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} />
                <p className="mt-1 text-[11px] text-zinc-400">{de ? 'Mindestens 8 Zeichen.' : 'At least 8 characters.'}</p>
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <Button type="submit" disabled={busy || !email || password.length < 8} className="w-full py-2.5 text-[15px] font-semibold">
                {de ? 'Haushalt anlegen →' : 'Create household →'}
              </Button>
              <div className="pt-1 text-center">
                <button type="button" onClick={() => switchMode('login')} className="text-xs text-zinc-500 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200">
                  {de ? 'Schon ein Konto? Anmelden' : 'Already have an account? Log in'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4">
              <div>
                <Label>{t('login.email')}</Label>
                <Input value={username} onChange={e => setUsername(e.target.value)} autoFocus autoCapitalize="none" type="email" />
              </div>
              <div>
                <Label>{t('login.password')}</Label>
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} />
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <Button type="submit" disabled={busy || !username || !password} className="w-full">
                {t('login.submit')}
              </Button>
              <div className="pt-1 text-center">
                <button type="button" onClick={() => switchMode('signup')} className="text-sm font-medium text-emerald-600 hover:underline dark:text-emerald-500">
                  {de ? 'Neu hier? Eigenen Haushalt anlegen →' : 'New here? Create your own household →'}
                </button>
              </div>
            </form>
          )}
        </Card>
      </div>
    );
  }

  // ── OFF-DEMO (dev/prod): classic single-household login + password recovery ──
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="relative w-full max-w-sm p-6">
        {versionBadge}
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
            {error && <p className="text-sm text-red-500">{error}</p>}
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
