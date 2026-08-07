import { app, BrowserWindow, utilityProcess, powerSaveBlocker } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './boot.mjs';

// VDS desktop shell. Electron IS Node, so the backend runs as a utilityProcess (Electron's
// bundled Node) against a bundled Postgres — no Docker, no separate runtime to install.
// Requires Electron ≥ 28 for ESM main. This is the boot PoC: window + lifecycle; packaging,
// searxng sidecar, the Tailscale-Funnel tunnel and the QR/PWA invite come next.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev the backend lives at ../backend/dist; a packaged build bundles it under resources.
const backendEntry = app.isPackaged
  ? path.join(process.resourcesPath, 'backend', 'dist', 'index.js')
  : path.join(__dirname, '..', 'backend', 'dist', 'index.js');

let stack = null;
let win = null;

async function start() {
  // Keep the machine reachable for phones while the app is open + plugged in.
  powerSaveBlocker.start('prevent-app-suspension');

  stack = await boot({
    dataDir: app.getPath('userData'),
    backendEntry,
    // No fixed port — boot picks a free one (a stray server on 8899 must not break us).
    // Electron forks Node via utilityProcess so the child uses Electron's runtime, not a system node.
    forker: (entry, env) => utilityProcess.fork(entry, [], { env, stdio: 'inherit' }),
  });

  win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Vorratsdatenspeicher',
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true },
  });

  // Wait for the backend to answer before showing the app, so the user never sees a blank/refused page.
  await waitForBackend(stack.url);
  await win.loadURL(stack.url);
}

async function waitForBackend(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/version`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
}

// Single-instance: a second launch must not spin up a second Postgres+backend against the same
// data dir (that's how we leaked orphaned processes). Re-focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(start);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', async (e) => {
  if (stack) { e.preventDefault(); const s = stack; stack = null; await s.stop(); app.exit(0); }
});
