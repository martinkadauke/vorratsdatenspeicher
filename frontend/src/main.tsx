import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './i18n';
import './index.css';
import { App } from './App';
import { AuthProvider } from './context/auth';

// Dark mode default before first paint (overridden by user preference after login)
const storedDark = localStorage.getItem('vds_dark');
document.documentElement.classList.toggle('dark', storedDark !== 'false');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
