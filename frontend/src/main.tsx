import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './i18n';
import './index.css';
import { App } from './App';
import { AuthProvider } from './context/auth';

// ⚠️ Pinch-Zoom auf iOS abschalten. Safari ignoriert `user-scalable=no` im viewport-Tag seit
// iOS 10 bewusst — die einzige verbliebene Handhabe sind diese drei Ereignisse. Ohne sie bleibt
// das Zoomen genau dort möglich, wo es am meisten stört: in der PWA auf dem Telefon, beim Wischen
// durch Belegpositionen.
//
// Absichtlich NUR Pinch: der Browser-Zoom am Desktop (Strg+Rad, Seitenzoom) bleibt unangetastet,
// weil er dort eine echte Notwendigkeit ist und keine Fehlbedienung.
for (const ereignis of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ereignis, (e) => e.preventDefault(), { passive: false });
}

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
  // The worker precaches the app so it OPENS without a network. When that fails it must not throw
  // — being offline during install is legitimate — but it must not be silent either: a cache that
  // is quietly empty looks identical to a working install until someone is standing in a shop.
  // The desktop shell already writes renderer console output into vds-desktop.log, so this lands
  // in the same file as everything else.
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'vds:precache') return;
    if (d.ok) console.info(`[vds] offline-ready: ${d.files} files cached (build ${d.buildId})`);
    else console.warn(`[vds] offline cache NOT ready: ${d.error}`);
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
