import { app, BrowserWindow, Menu, dialog, shell, utilityProcess, powerSaveBlocker } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { boot } from './boot.mjs';
import { startTunnel, sidecarPath, hasTunnelState } from './tunnel.mjs';

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
let tunnel = null;        // handle from startTunnel(), or null when the tunnel is off
let authWin = null;       // the in-app Tailscale login window, while it is open

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

/** The in-app "Jetzt aktualisieren" button, for the desktop build.
 *
 *  Reuses the EXISTING protocol rather than inventing a second one: the backend's
 *  POST /api/self-update drops a marker file in SELF_UPDATE_DIR (that is how the Docker updater
 *  sidecar is triggered too), and here the shell watches for it and runs electron-updater. So the
 *  same button, the same endpoint and the same banner serve both channels.
 *
 *  ⚠️ Auto-update needs the `latest.yml` / `latest-mac.yml` metadata that electron-builder only
 *  emits when a `publish` block exists — v0.17.0 shipped without it, so the first version this can
 *  actually update FROM is the next release.
 *  ⚠️ macOS refuses to auto-install an UNSIGNED update (Squirrel.Mac verifies the signature). We
 *  detect that and send the user to the download page instead of failing silently. */
function watchForUpdateRequest(updaterDir) {
  const marker = path.join(updaterDir, 'request');
  let running = false;

  const openDownloads = () => shell.openExternal('https://github.com/martinkadauke/vorratsdatenspeicher/releases/latest');

  const run = async () => {
    if (running) return;
    running = true;
    try {
      fs.rmSync(marker, { force: true });        // consume it, so one click = one attempt
      if (!app.isPackaged) { log('update requested but this is a dev run — ignoring'); return; }
      // An unsigned .app cannot be replaced in place; hand over to the browser instead of
      // pretending to update and dying half-way.
      if (process.platform === 'darwin') { log('update requested on macOS (unsigned) → opening downloads'); openDownloads(); return; }

      // ⚠️ NOT `const { autoUpdater } = await import(...)`. electron-updater is CommonJS and
      // publishes autoUpdater through `Object.defineProperty(exports, 'autoUpdater', { get })`
      // whose body is `_autoUpdater || doLoadAutoUpdater()`. Node's CJS named-export detection only
      // recognises the simple `return X.Y` getter form, so this one name — and only this one, its
      // siblings like NsisUpdater use the simple form — comes back UNDEFINED. That is what made
      // every "Jetzt aktualisieren" click in 0.18–0.20 die with
      // "Cannot set properties of undefined (setting 'autoDownload')" and fall back to the
      // downloads page. Verified under real Electron: the namespace has no `autoUpdater`; the
      // object lives on `.default`.
      const updaterModule = await import('electron-updater');
      const autoUpdater = updaterModule.autoUpdater ?? updaterModule.default?.autoUpdater;
      if (!autoUpdater) throw new Error('electron-updater exposed no autoUpdater');
      autoUpdater.autoDownload = true;
      autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
      autoUpdater.on('update-not-available', () => log('update requested but none available'));
      autoUpdater.on('error', (e) => { log(`update failed: ${(e && e.message) || e}`); openDownloads(); });
      autoUpdater.on('update-downloaded', () => { log('update downloaded — restarting to install'); setImmediate(() => autoUpdater.quitAndInstall()); });
      log('checking for updates …');
      await autoUpdater.checkForUpdates();
    } catch (e) {
      log(`update trigger failed: ${(e && e.stack) || e}`);
      openDownloads();
    } finally { running = false; }
  };

  try {
    // fs.watch can miss/duplicate events across platforms; a cheap poll is the reliable floor for
    // a file that appears at most once per user click.
    setInterval(() => { if (fs.existsSync(marker)) void run(); }, 1500).unref();
    log(`watching for update requests in ${updaterDir}`);
  } catch (e) { log(`could not watch updater dir: ${e}`); }
}

// ── "Handy verbinden": the shell half of the tunnel bridge ──────────────────────────────────
// The web UI cannot talk to Electron (it is served over http from the backend and has no preload),
// and the backend must not be able to spawn a Tailscale node. So the UI writes a REQUEST file that
// this watcher acts on, and this watcher writes a STATUS file the backend serves back. Same shape
// as the self-update marker — one bridge mechanism for the whole desktop build.

/** Publish the tunnel state for the backend (and therefore the UI) to read. Written via a temp file
 *  + rename so a poll can never catch a half-written JSON. */
function writeTunnelStatus(desktopDir, status) {
  const file = path.join(desktopDir, 'tunnel-status.json');
  const body = JSON.stringify({ ...status, at: new Date().toISOString() });
  try {
    fs.writeFileSync(`${file}.tmp`, body);
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) { log(`could not write tunnel status: ${e}`); }
  log(`tunnel state: ${status.state}${status.url ? ` (${status.url})` : ''}${status.detail ? ` — ${status.detail}` : ''}`);
}

/** Send the Tailscale login to the user's own browser.
 *
 *  ⚠️ This USED to open an in-app window, because "one app, no detour" is the promise. It does not
 *  work: Google refuses OAuth from anything it identifies as an embedded browser and answers
 *  "Couldn't sign you in — This browser or app may not be secure", after the user has already gone
 *  through the whole passkey dance on their phone. Scrubbing "Electron" out of the user agent was
 *  not enough; that loophole is closed, and the other providers can close theirs any day.
 *
 *  The browser is also simply better here: the user is already signed in to Google there, their
 *  password manager and passkeys work, and it is where every other desktop app does OAuth. Nothing
 *  about the promise breaks — the login is a one-time step, and the app keeps polling on its own,
 *  so the user just switches back when it is done. */
function openAuthWindow(url) {
  log('opening the tailnet login in the system browser');
  void shell.openExternal(url);
}

function closeAuthWindow() {
  try { if (authWin && !authWin.isDestroyed()) authWin.close(); } catch { /* already gone */ }
  authWin = null;
}

function startTunnelFor(stack, { openLogin }) {
  if (tunnel) return;
  const binPath = sidecarPath({
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    devRoot: app.isPackaged ? null : __dirname,
  });
  log(`starting tunnel (sidecar: ${binPath || 'NOT FOUND'})`);
  tunnel = startTunnel({
    localPort: stack.port,
    stateDir: stack.tsnetDir,
    binPath,
    log,
    onEvent: (e) => {
      // A resumed session must never pop a login window at the user unprompted; only an explicit
      // "Handy verbinden" click does. Auto-start on later launches is silent by design.
      if (e.state === 'auth' && openLogin) openAuthWindow(e.authUrl);
      if (e.state === 'connecting' || e.state === 'up') closeAuthWindow();
      if (e.state === 'error') tunnel = null;
      writeTunnelStatus(stack.desktopDir, e);
    },
  });
}

async function stopTunnel(stack) {
  const t = tunnel;
  tunnel = null;
  closeAuthWindow();
  if (t) { try { await t.stop(); } catch (e) { log(`tunnel stop failed: ${e}`); } }
  writeTunnelStatus(stack.desktopDir, { state: 'off' });
}

/** Locked out of your own machine: hand out a one-time code through a NATIVE dialog.
 *
 *  A desktop instance has no working "reset by e-mail" story — it needs SMTP, an inbox, and a link
 *  that outlives the app — and it does not need one: the owner is sitting at the keyboard. That
 *  physical presence is the factor, and an OS dialog is the one surface a web page can neither read
 *  nor fake. The confirm step matters: any local page can POST the request, so the worst it can do
 *  is raise a prompt the user says no to.
 *  Ambiguous characters (0/O, 1/I) are left out — this gets read off a screen and typed by hand. */
async function issueRecoveryCode(stack) {
  const answer = await dialog.showMessageBox(win ?? undefined, {
    type: 'question', buttons: ['Code anzeigen', 'Abbrechen'], defaultId: 0, cancelId: 1,
    title: 'Passwort zurücksetzen',
    message: 'Passwort für Vorratsdatenspeicher zurücksetzen?',
    detail: 'Du bekommst einen Einmal-Code, den du im Fenster eingibst. Danach kannst du ein neues Passwort vergeben.',
  });
  if (answer.response !== 0) { log('recovery declined in the dialog'); return; }

  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = Array.from(crypto.randomBytes(8), b => A[b % A.length]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  fs.writeFileSync(path.join(stack.desktopDir, 'recover.json'), JSON.stringify({ code, expires }), { mode: 0o600 });
  log('recovery code issued (valid 10 minutes)');

  await dialog.showMessageBox(win ?? undefined, {
    type: 'info', buttons: ['OK'], title: 'Dein Einmal-Code',
    message: code,
    detail: 'Gib diesen Code im Vorratsdatenspeicher-Fenster ein. Er gilt 10 Minuten und nur ein einziges Mal.',
  });
}

function watchDesktopBridge(stack) {
  const request = path.join(stack.desktopDir, 'tunnel-request');
  const recoverRequest = path.join(stack.desktopDir, 'recover-request');
  let busy = false;
  let recovering = false;

  setInterval(() => {
    if (recovering || !fs.existsSync(recoverRequest)) return;
    recovering = true;
    try { fs.rmSync(recoverRequest, { force: true }); } catch { /* consumed anyway */ }
    issueRecoveryCode(stack)
      .catch(e => log(`recovery failed: ${(e && e.stack) || e}`))
      .finally(() => { recovering = false; });
  }, 1000).unref();

  // Bring a previously connected instance back up on its own: the phone's saved URL and its
  // passkeys are bound to this node, so a household that has connected once expects it to just
  // work after a restart. A never-connected install stays quiet (no account, no prompt).
  if (hasTunnelState(stack.tsnetDir)) {
    log('previous tailnet login found — resuming the tunnel');
    startTunnelFor(stack, { openLogin: false });
  } else {
    writeTunnelStatus(stack.desktopDir, { state: 'off' });
  }

  setInterval(() => {
    if (busy || !fs.existsSync(request)) return;
    busy = true;
    let action = 'start';
    try { action = (fs.readFileSync(request, 'utf8').split('\n')[0] || 'start').trim(); } catch { /* default */ }
    try { fs.rmSync(request, { force: true }); } catch { /* consumed anyway */ }
    log(`tunnel request: ${action}`);
    Promise.resolve()
      .then(() => (action === 'stop' ? stopTunnel(stack) : startTunnelFor(stack, { openLogin: true })))
      .catch((e) => { log(`tunnel request failed: ${e}`); writeTunnelStatus(stack.desktopDir, { state: 'error', reason: 'request_failed', detail: String(e?.message || e) }); })
      .finally(() => { busy = false; });
  }, 1000).unref();
  log(`watching for tunnel requests in ${stack.desktopDir}`);
}

/** Send every outward link to the user's own browser.
 *
 *  A `target="_blank"` in a normal page opens a new browser tab; inside Electron it opens a bare
 *  Chromium window with no address bar, no bookmarks, no logged-in session — so "Vorratsdatenspeicher
 *  weiterempfehlen → Reddit" dumped the user into a stripped window they were not signed in to.
 *  Anything that is not this app belongs in the browser they actually use.
 *
 *  ⚠️ Only the app window is wired up. The Tailscale login window is deliberately in-app (that is
 *  the whole "one app, no detour" promise) and is created by us with loadURL, not window.open, so
 *  it never passes through here. */
function keepLinksInTheBrowser(contents, appOrigin) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };   // never a second Electron window
  });
  // Same for a plain link that would navigate the app window away from the app itself.
  contents.on('will-navigate', (e, url) => {
    if (url.startsWith(appOrigin) || url.startsWith('data:')) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
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
  // Drop "vorratsdatenspeicher-desktop/x.y.z" and "Electron/33.x" from the user agent. Google (and
  // others) refuse OAuth sign-in from a user agent that announces itself as an embedded browser,
  // and the Tailscale login we open in-window is exactly that flow. Nothing else reads our UA.
  app.userAgentFallback = app.userAgentFallback.replace(/ (vorratsdatenspeicher-desktop|Electron)\/[\d.]+/g, '');

  const dataDir = app.getPath('userData');
  log(`starting · version=${app.getVersion()} · dataDir=${dataDir}`);
  // The bundled Postgres cannot live under a path containing a space (initdb exits 1). setName()
  // above prevents it, but a user profile like "C:\Users\Max Mustermann" would too — so say it
  // plainly instead of failing three steps later with an empty error.
  if (/\s/.test(dataDir)) throw new Error(`Der Datenpfad enthält ein Leerzeichen, damit kommt die mitgelieferte Datenbank nicht zurecht:\n${dataDir}`);

  // The window comes up FIRST, showing what is happening. Creating the cluster and running every
  // migration takes ~50s on a warm machine and longer on a cold one; doing that behind an empty
  // window is exactly what "wieder nur weisser screen" was. Nobody should have to guess whether
  // the app is working or broken.
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Vorratsdatenspeicher Desktop',
    icon: iconPath,
    backgroundColor: '#f4eee0',
    autoHideMenuBar: true,   // belt-and-suspenders on top of setApplicationMenu(null)
    webPreferences: { contextIsolation: true },
  });
  await win.loadURL(splashUrl());

  // One automatic retry. The first launch after an install has been seen to leave the database
  // half-started; restarting the app by hand fixed it, so do that FOR the user instead of
  // handing them a dead window.
  for (let attempt = 1; attempt <= 2; attempt++) {
    stack = await boot({
      dataDir,
      backendEntry,
      // No fixed port — boot picks a free one (a stray server on 8899 must not break us).
      // Electron forks Node via utilityProcess so the child uses Electron's runtime, not a system node.
      forker: (entry, env) => utilityProcess.fork(entry, [], { env, stdio: 'inherit' }),
    });
    log(`backend booting on ${stack.url} (attempt ${attempt})`);
    if (attempt === 1) watchForUpdateRequest(stack.updaterDir);

    if (await waitForBackend(stack.url)) {
      log('backend ready — loading UI');
      keepLinksInTheBrowser(win.webContents, stack.url);
      // Only now: the bridge needs the port of the backend that actually came up (a retry picks a
      // new one), and a tunnel pointed at the failed attempt would proxy to nothing.
      watchDesktopBridge(stack);
      await win.loadURL(stack.url);
      return;
    }

    log(`backend did not come up on attempt ${attempt}`);
    if (attempt === 1) {
      try { await stack.stop(); } catch (e) { log(`teardown before retry failed: ${e}`); }
      stack = null;
      await win.loadURL(splashUrl(true));
    }
  }
  throw new Error('Die Datenbank ist auch beim zweiten Versuch nicht gestartet.');
}

/** What the user looks at while the database is being prepared. Inline data URL — no extra file
 *  to bundle, and it renders before anything else exists. */
function splashUrl(retrying = false) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    @keyframes p{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#f4eee0;color:#2c2620;font:16px/1.6 ui-monospace,Consolas,monospace}
    .w{text-align:center;max-width:32rem;padding:24px}
    h1{font-size:19px;margin:0 0 10px;letter-spacing:.02em}
    p{margin:0;color:#5f584c;font-size:14px}
    .bar{margin:22px auto 0;width:220px;height:4px;background:#e0d8c4;border-radius:2px;overflow:hidden}
    .bar i{display:block;width:25%;height:100%;background:#3d6a4e;animation:p 1.4s ease-in-out infinite}
    </style><div class="w">
    <h1>Vorratsdatenspeicher wird vorbereitet</h1>
    <p>${retrying
      ? 'Der erste Versuch hat nicht geklappt — die App probiert es gerade noch einmal.'
      : 'Beim ersten Start wird die Datenbank angelegt. Das dauert etwa eine Minute — das Fenster bleibt so lange offen.'}</p>
    <div class="bar"><i></i></div></div>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
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
  if (stack) {
    e.preventDefault();
    const s = stack; stack = null;
    // Tunnel first: leaving the node online after the backend is gone would publish an HTTPS
    // address that answers with connection-refused, which reads to a phone as "the app is broken"
    // rather than "the computer is off".
    try { await stopTunnel(s); } catch { /* best effort */ }
    await s.stop();
    app.exit(0);
  }
});
