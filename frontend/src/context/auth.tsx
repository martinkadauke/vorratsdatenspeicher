import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
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
    const onLogout = () => setUser(null);
    window.addEventListener('vds:logout', onLogout);
    (async () => {
      if (getToken()) await refreshUser();
      setLoading(false);
    })();
    return () => window.removeEventListener('vds:logout', onLogout);
  }, []);

  const login = async (username: string, password: string) => {
    const res = await api<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    setToken(res.token);
    applyUser(res.user);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
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
