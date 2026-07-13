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

// Load pages at the top. The browser's default scroll restoration re-applied a mid-page
// scroll on refresh (once async content grew the page back to that height), hiding the top
// of the page — e.g. the Statistik month carousel. Must be set before first paint.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// Register the service worker (Web Push). Best-effort; failures are non-fatal.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* ignore */ });
  });
}

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
