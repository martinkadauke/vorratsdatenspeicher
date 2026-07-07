import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, setToken } from '../api/client';
import type { User } from '../api/types';
import { setLanguage } from '../i18n';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

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

  const logout = () => {
    setToken(null);
    setUser(null);
    queryClient.clear();
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
