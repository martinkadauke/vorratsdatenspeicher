import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Fingerprint } from 'lucide-react';
import { useAuth } from '../context/auth';
import { api, ApiError, setToken } from '../api/client';
import { passkeySupported } from '../api/passkey';
import { Button, Input, Label, Card, Spinner } from '../components/ui';

interface VersionInfo { sha: string; ref: string; demo?: boolean; needs_setup?: boolean; needs_account?: boolean; desktop?: boolean }

export function Login() {
  const { login, loginPasskey, signup, setup, refreshUser } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const de = i18n.language.startsWith('de');
  const [pkBusy, setPkBusy] = useState(false);
  const doPasskey = async () => {
    setPkBusy(true);
    setError('');
    try {
      await loginPasskey();
      navigate('/receipts');
    } catch {
      // user cancelled, no passkey on this device, or verification failed → gentle hint
      setError(t('login.passkeyError'));
    } finally {
      setPkBusy(false);
    }
  };

  // Resolve the version (and its demo flag) before choosing a mode, so the demo
  // signup-first flow never flashes the plain login form (or vice-versa).
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const demo = !!version?.demo;
  // ⚠️ Below `demo`, never above it. The demo build registers no passkey routes at all, so the
  // button would lead into a 404 that reads as "this app is broken" — but reading `demo` before
  // its declaration is a ReferenceError at render, which is the exact shape of the two black
  // windows this project shipped today.
  const canPasskey = passkeySupported() && !demo;

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
  // Desktop-only lock-out recovery (see below): code requested → typed back with a new password.
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [admins, setAdmins] = useState<string[]>([]);

  useEffect(() => {
    api<VersionInfo>('/api/version')
      .then(v => {
        setVersion(v);
        if (v.demo) setMode('signup');
      })
      .catch(() => setVersion({ sha: 'unknown', ref: 'unknown' }));
  }, []);

  // Brand-new instance (no users at all): the owner creates their own account here, once.
  // No default password is shipped any more; afterwards the instance is invite-only.
  const needsAccount = !demo && !!version?.needs_account;
  const submitSetup = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await setup(username.trim(), password, email.trim());
      navigate('/receipts');
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 409 ? t('login.setup.taken') : status === 400 ? t('login.setup.invalid') : t('login.errorNetwork'));
      // Someone else finished setup first → re-read the flag so the form flips to a login.
      if (status === 409) void api<VersionInfo>('/api/version').then(setVersion).catch(() => { /* keep */ });
    } finally {
      setBusy(false);
    }
  };

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

  // ── locked out of the app running on your own computer ───────────────────────────────────
  // The e-mail round trip cannot be the answer here: it needs SMTP set up, a reachable inbox and a
  // link that survives — and the person is standing in front of the machine. So the app asks the
  // machine instead: the shell shows a one-time code in a native OS dialog (which no web page can
  // read) and that code, typed back here, sets a new password.
  const desktop = !!version?.desktop;
  const requestCode = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/desktop/recover', { method: 'POST' });
      const { admins: list } = await api<{ admins: string[] }>('/api/desktop/admins');
      setAdmins(list);
      if (list.length && !username) setUsername(list[0]);
      setCodeSent(true);
    } catch {
      setError(t('login.recover.failed'));
    } finally {
      setBusy(false);
    }
  };

  const submitRecover = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { token } = await api<{ token: string }>('/api/desktop/recover/confirm', {
        method: 'POST', body: { code, username: username.trim(), password },
      });
      setToken(token);
      await refreshUser();
      navigate('/receipts');
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 410 ? t('login.recover.expired')
        : status === 403 ? t('login.recover.wrongCode')
        : status === 404 ? t('login.recover.noAdmin')
        : t('login.recover.failed'));
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
    // The very first frame a demo visitor ever sees — worth carrying the mark.
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
        <img src="/icon-192.png" alt="" className="h-16 w-16 rounded-2xl" />
        <Spinner />
      </div>
    );
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
            <img src="/icon-192.png" alt="" className="mx-auto h-16 w-16 rounded-2xl" />
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
              {canPasskey && (
                <button type="button" onClick={doPasskey} disabled={pkBusy}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-300 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
                  <Fingerprint size={16} /> {t('login.passkey')}
                </button>
              )}
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
          <img src="/icon-192.png" alt="" className="mx-auto h-14 w-14 rounded-2xl" />
          <h1 className="mt-2 text-xl font-bold tracking-tight">{t('login.title')}</h1>
        </div>

        {/* Brand-new instance: create the owner account, once. No default password is shipped. */}
        {needsAccount ? (
          <form onSubmit={submitSetup} className="flex flex-col gap-4">
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-3.5 py-3 text-[13px] leading-snug text-emerald-900 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200">
              <p className="font-semibold">{t('login.setup.title')}</p>
              <p className="mt-1">{t('login.setup.intro')}</p>
            </div>
            <div>
              <Label>{t('login.username')}</Label>
              <Input value={username} onChange={e => setUsername(e.target.value)} autoFocus autoCapitalize="none" autoComplete="username" />
            </div>
            <div>
              <Label>{t('login.password')}</Label>
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
              <p className="mt-1 text-[11px] text-zinc-400">{t('login.setup.pwHint')}</p>
            </div>
            <div>
              <Label>{t('login.setup.emailLabel')}</Label>
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} autoCapitalize="none" autoComplete="email" placeholder="deine@email.de" />
              <p className="mt-1 text-[11px] text-zinc-400">{t('login.setup.emailHint')}</p>
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button type="submit" disabled={busy || !username.trim() || password.length < 8} className="w-full py-2.5 text-[15px] font-semibold">
              {busy ? '…' : t('login.setup.submit')}
            </Button>
            <p className="text-center text-[11px] leading-relaxed text-zinc-400">{t('login.setup.inviteNote')}</p>
          </form>
        ) : forgotMode && desktop ? (
          !codeSent ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{t('login.recover.blurb')}</p>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <Button onClick={requestCode} disabled={busy}>{busy ? '…' : t('login.recover.request')}</Button>
              <button type="button" onClick={() => setForgotMode(false)} className="text-xs text-zinc-400 hover:underline">
                {t('login.backToLogin')}
              </button>
            </div>
          ) : (
            <form onSubmit={submitRecover} className="flex flex-col gap-4">
              <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">{t('login.recover.enterBlurb')}</p>
              <div>
                <Label>{t('login.recover.code')}</Label>
                <Input value={code} onChange={e => setCode(e.target.value.toUpperCase())} autoFocus autoCapitalize="characters"
                  placeholder="ABCD-EFGH" className="font-mono tracking-widest" />
              </div>
              <div>
                <Label>{t('login.username')}</Label>
                {admins.length > 1 ? (
                  <select value={username} onChange={e => setUsername(e.target.value)}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900">
                    {admins.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                ) : (
                  <Input value={username} onChange={e => setUsername(e.target.value)} autoCapitalize="none" />
                )}
              </div>
              <div>
                <Label>{t('login.recover.newPassword')}</Label>
                <Input type="password" value={password} onChange={e => setPassword(e.target.value)} />
              </div>
              {error && <p className="text-sm text-red-500">{error}</p>}
              <Button type="submit" disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length < 8 || password.length < 8 || !username.trim()}>
                {busy ? '…' : t('login.recover.submit')}
              </Button>
              <button type="button" onClick={() => { setForgotMode(false); setCodeSent(false); setCode(''); }} className="text-xs text-zinc-400 hover:underline">
                {t('login.backToLogin')}
              </button>
            </form>
          )
        ) : forgotMode ? (
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
            {canPasskey && (
              <button type="button" onClick={doPasskey} disabled={pkBusy}
                className="flex items-center justify-center gap-2 rounded-lg border border-zinc-300 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
                <Fingerprint size={16} /> {t('login.passkey')}
              </button>
            )}
            <button type="button" onClick={() => setForgotMode(true)} className="text-xs text-zinc-400 hover:underline">
              {t('login.forgot')}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}
