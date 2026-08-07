import { app, BrowserWindow, Menu, utilityProcess, powerSaveBlocker } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { boot } from './boot.mjs';

// ⚠️ MUST run before any app.getPath('userData'): Electron derives userData from the app NAME,
// which defaults to productName — "Vorratsdatenspeicher Desktop" — giving a path WITH A SPACE.
// The bundled Postgres cannot initialise into such a path (initdb exits 1; proven side by side),
// so v1.0.16 shipped a white screen: boot rejected, the window opened against a dead server.
// Pinning a space-free name keeps the packaged app on the same path shape as a dev run.
app.setName('vorratsdatenspeicher-desktop');

// VDS desktop shell. Electron IS Node, so the backend runs as a utilityProcess (Electron's
// bundled Node) against a bundled Postgres — no Docker, no separate runtime to install.
// Requires Electron ≥ 28 for ESM main. This is the boot PoC: window + lifecycle; packaging,
// searxng sidecar, the Tailscale-Funnel tunnel and the QR/PWA invite come next.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev the backend lives at ../backend/dist; a packaged build bundles it under resources.
const backendEntry = app.isPackaged
  ? path.join(process.resourcesPath, 'backend', 'dist', 'index.js')
  : path.join(__dirname, '..', 'backend', 'dist', 'index.js');
// Dev: the rounded-corner .ico (taskbar + titlebar). Packaged: electron-builder bakes
// build/icon.ico into the exe for the taskbar; the window falls back to the bundled png.
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'frontend', 'dist', 'icon-512.png')
  : path.join(__dirname, 'build', 'icon.ico');

let stack = null;
let win = null;

/** Everything the app does gets a line here. Without it a packaged failure is invisible: there is
 *  no console attached to a Windows GUI build, so "white screen" was all anyone could report. */
function logPath() { return path.join(app.getPath('userData'), 'vds-desktop.log'); }
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(logPath(), line); } catch { /* logging must never throw */ }
  console.log(line.trim());
}

/** Replace the blank window with something a human can act on. embedded-postgres rejects with
 *  `undefined` on failure, so the message has to survive a useless error object. */
function showFailure(err) {
  const detail = String((err && (err.stack || err.message)) || err || 'unbekannter Fehler');
  log(`FATAL: ${detail}`);
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font:15px/1.6 system-ui,sans-serif;background:#f4eee0;color:#2c2620;margin:0;padding:40px;display:flex;justify-content:center}
    .w{max-width:560px}h1{font-size:20px;margin:0 0 12px}code{background:#e6dfcd;padding:2px 6px;border-radius:3px;font-size:12px;word-break:break-all}
    pre{background:#e6dfcd;padding:12px;border-radius:6px;overflow:auto;font-size:12px;max-height:220px}</style>
    <div class="w"><h1>Vorratsdatenspeicher konnte nicht starten</h1>
    <p>Beim Start der mitgelieferten Datenbank ist etwas schiefgegangen. Die App wurde <b>nicht</b> beschädigt und deine Daten sind unberührt.</p>
    <p><b>Was hilft meistens:</b> die App komplett schließen und neu starten. Bleibt der Fehler, schick uns bitte die Logdatei:</p>
    <p><code>${logPath().replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code></p>
    <p>An <a href="mailto:webmaster@vorratsdatenspeicher.com">webmaster@vorratsdatenspeicher.com</a> — wir schauen es uns an.</p>
    <pre>${detail.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></div>`;
  try {
    if (!win) win = new BrowserWindow({ width: 720, height: 620, title: 'Vorratsdatenspeicher Desktop', icon: iconPath });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  } catch (e) { console.error(e); }
}

async function start() {
  // No native menu bar — this is an appliance, not a document editor (removes File/Edit/View/…).
  Menu.setApplicationMenu(null);
  // Let the bundled backend report the real release version (/api/version → drives the in-app
  // "update available" check). CI stamps it via electron-builder's extraMetadata.version, so
  // app.getVersion() is the release number; a dev run just reports package.json's.
  process.env.APP_VERSION = app.getVersion();
  // Keep the machine reachable for phones while the app is open + plugged in.
  powerSaveBlocker.start('prevent-app-suspension');

  const dataDir = app.getPath('userData');
  log(`starting · version=${app.getVersion()} · dataDir=${dataDir}`);
  // The bundled Postgres cannot live under a path containing a space (initdb exits 1). setName()
  // above prevents it, but a user profile like "C:\Users\Max Mustermann" would too — so say it
  // plainly instead of failing three steps later with an empty error.
  if (/\s/.test(dataDir)) throw new Error(`Der Datenpfad enthält ein Leerzeichen, damit kommt die mitgelieferte Datenbank nicht zurecht:\n${dataDir}`);

  stack = await boot({
    dataDir,
    backendEntry,
    // No fixed port — boot picks a free one (a stray server on 8899 must not break us).
    // Electron forks Node via utilityProcess so the child uses Electron's runtime, not a system node.
    forker: (entry, env) => utilityProcess.fork(entry, [], { env, stdio: 'inherit' }),
  });
  log(`backend booting on ${stack.url}`);

  win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Vorratsdatenspeicher Desktop',
    icon: iconPath,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,   // belt-and-suspenders on top of setApplicationMenu(null)
    webPreferences: { contextIsolation: true },
  });

  // Wait for the backend to answer before showing the app, so the user never sees a blank/refused
  // page. A FIRST run has to create the cluster and run every migration, which on a cold or slow
  // machine takes well over a minute — hence the generous budget.
  const ready = await waitForBackend(stack.url);
  if (!ready) throw new Error('Die Datenbank ist nicht rechtzeitig gestartet. Bitte die App neu starten.');
  log('backend ready — loading UI');
  await win.loadURL(stack.url);
}

async function waitForBackend(base, tries = 360) {   // 360 × 500ms = 3 minutes
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/version`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    if (i === 40) log('backend still starting (first run creates the database) …');
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// Windows taskbar/notification identity (also lets the packaged exe icon group correctly).
if (process.platform === 'win32') app.setAppUserModelId('com.vorratsdatenspeicher.desktop');

// Single-instance: a second launch must not spin up a second Postgres+backend against the same
// data dir (that's how we leaked orphaned processes). Re-focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  // .catch is load-bearing: without it a boot failure was an unhandled rejection, the window
  // loaded against a dead server, and the user got a white screen with nothing to report.
  app.whenReady().then(start).catch(showFailure);
}
// embedded-postgres rejects with `undefined`; catch those too so nothing is ever swallowed.
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${(e && e.stack) || e}`));
process.on('uncaughtException', (e) => log(`uncaughtException: ${(e && e.stack) || e}`));

app.on('window-all-closed', () => app.quit());
app.on('before-quit', async (e) => {
  if (stack) { e.preventDefault(); const s = stack; stack = null; await s.stop(); app.exit(0); }
});
