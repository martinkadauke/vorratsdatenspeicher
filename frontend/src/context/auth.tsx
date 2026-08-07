import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, setToken } from '../api/client';
import { loginWithPasskey } from '../api/passkey';
import type { User } from '../api/types';
import { setLanguage } from '../i18n';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** DEMO_MODE flag from /api/version — drives demo-only UI (signup, install button,
   *  household admin). Always false off-demo (dev/prod), so demo UI never renders there. */
  demo: boolean;
  login: (username: string, password: string) => Promise<void>;
  loginPasskey: () => Promise<void>;
  signup: (email: string, password: string, household: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [demo, setDemo] = useState(false);

  const applyUser = (u: User | null) => {
    setUser(u);
    if (u) {
      setLanguage(u.preferred_lang);
      document.documentElement.classList.toggle('dark', u.prefers_dark);
    }
  };

  const refreshUser = async () => {
    try {
      const { user: u } = await api<{ user: User }>('/api/auth/me');
      applyUser(u);
    } catch {
      applyUser(null);
    }
  };

  useEffect(() => {
    // A 401 (expired/invalid token) logs out — also drop the cache so the next
    // user in this browser never sees the previous user's queries.
    const onLogout = () => { setUser(null); queryClient.clear(); };
    window.addEventListener('vds:logout', onLogout);
    (async () => {
      // Resolve the demo flag BEFORE clearing loading, so demo-gated UI never
      // flashes the wrong state on first render (Login signup, admin sections).
      try { const v = await api<{ demo?: boolean }>('/api/version'); setDemo(!!v.demo); } catch { /* default false */ }
      if (getToken()) await refreshUser();
      setLoading(false);
    })();
    return () => window.removeEventListener('vds:logout', onLogout);
  }, [queryClient]);

  const login = async (username: string, password: string) => {
    const res = await api<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    // Drop any cached queries from a previous session BEFORE the new user's data
    // loads — otherwise the last user's cached results (mailbox, receipts, konten,
    // …) bleed into this account until each query happens to refetch.
    queryClient.clear();
    setToken(res.token);
    applyUser(res.user);
  };

  // Passwordless login: the passkey verify returns only a token (like signup), so set it
  // then load the user via /api/auth/me.
  const loginPasskey = async () => {
    const token = await loginWithPasskey();
    queryClient.clear();
    setToken(token);
    await refreshUser();
  };

  // Open signup (demo only): creates a brand-new household + its admin, returns only a
  // token (no user body), so we set the token then load the user via /api/auth/me.
  const signup = async (email: string, password: string, household: string) => {
    const res = await api<{ token: string }>('/api/auth/signup', {
      method: 'POST',
      body: { email, password, household },
    });
    queryClient.clear();
    setToken(res.token);
    await refreshUser();
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    queryClient.clear();
  };

  return (
    <AuthContext.Provider value={{ user, loading, demo, login, loginPasskey, signup, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
