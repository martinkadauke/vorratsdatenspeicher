import { app, BrowserWindow, Menu, dialog, globalShortcut, shell, utilityProcess, powerSaveBlocker, Notification } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { boot } from './boot.mjs';
import { startTunnel, sidecarPath, hasTunnelState } from './tunnel.mjs';
import { selfInstall } from './selfInstall.mjs';

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
let probeGen = 0;         // only the newest reachability probe may write a verdict
let authWin = null;       // the in-app Tailscale login window, while it is open

/** Everything the app does gets a line here. Without it a packaged failure is invisible: there is
 *  no console attached to a Windows GUI build, so "white screen" was all anyone could report. */
function logPath() { return path.join(app.getPath('userData'), 'vds-desktop.log'); }
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(logPath(), line); } catch { /* logging must never throw */ }
  console.log(line.trim());
}

/** What can still be said when embedded-postgres rejects with nothing at all.
 *
 *  ⚠️ "FATAL: unbekannter Fehler" is the line a user was asked to send us: it records THAT
 *  something broke and nothing about WHAT. The pieces below cost nothing to read and name the two
 *  realistic causes on the spot — a predecessor still holding the data directory, or Postgres
 *  refusing and saying why in its own log rather than in the exception. */
function describeBootFailure(err, dataDir) {
  // ⚠️ Eigene Prüfung statt pidAlive aus boot.mjs: das ist dort nicht exportiert, und ein
  //    ReferenceError ausgerechnet im Fehlerpfad würde die Diagnose durch einen zweiten Absturz
  //    ersetzen. Signal 0 sendet nichts, es fragt nur "gibt es diesen Prozess".
  const lebt = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const teile = [String((err && (err.stack || err.message)) || err || "(die Datenbank meldete keinen Grund)")];
  try {
    const pidFile = path.join(dataDir, "pgdata", "postmaster.pid");
    if (fs.existsSync(pidFile)) {
      const pid = parseInt((fs.readFileSync(pidFile, "utf8").split("\n")[0] || "").trim(), 10);
      teile.push(`postmaster.pid vorhanden (pid ${pid}, ${Number.isFinite(pid) && lebt(pid) ? "LÄUFT NOCH" : "tot"})`);
    } else {
      teile.push("postmaster.pid: nicht vorhanden");
    }
  } catch (e) { teile.push(`pid-Datei nicht lesbar: ${e?.message ?? e}`); }
  // Postgres schreibt seinen echten Grund in sein eigenes Log, nicht in die Ausnahme.
  for (const rel of ["pgdata/log", "pgdata/pg_log"]) {
    try {
      const dir = path.join(dataDir, rel);
      const neueste = fs.readdirSync(dir).map(f => path.join(dir, f))
        .map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0];
      if (neueste) {
        const zeilen = fs.readFileSync(neueste.f, "utf8").trim().split(/\r?\n/).slice(-6);
        teile.push(`aus ${path.basename(neueste.f)}:` + "\n  " + zeilen.join("\n  "));
      }
    } catch { /* kein Log-Verzeichnis — bei embedded-postgres der Normalfall */ }
  }
  return teile.join("\n");
}

/** Replace the blank window with something a human can act on. */
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
      autoUpdater.on('update-downloaded', () => {
        log('update downloaded — stopping the database, then restarting to install');
        // Stop OURSELVES first: quitAndInstall does not wait for before-quit.
        void shutdownStack(stack).finally(() => setImmediate(() => autoUpdater.quitAndInstall()));
      });
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

/** Does the public address actually exist and answer — from the open internet?
 *
 *  ⚠️ Do not trust the sidecar's "funnel is up". ListenFunnel succeeds as soon as the node is
 *  ALLOWED to funnel (the `funnel` nodeAttr in the tailnet policy). Publishing the name is a second,
 *  independent switch: Tailscale only puts a tailnet into public DNS once HTTPS certificates are
 *  enabled for it. With the attribute set and HTTPS off, we cheerfully showed a QR code for a
 *  hostname that was NXDOMAIN — the user scans it and gets "site cannot be reached", with nothing
 *  anywhere saying why. So: prove it from outside before calling it up.
 *
 *  Retries, because two slow things happen on first exposure: the DNS record appearing, and
 *  Let's Encrypt issuing the certificate on the first request. */
const REACH_ATTEMPTS = 8;
// After the quick probe gives up, keep going quietly for another ~10 minutes. A funnel name that
// has just been created has to reach public DNS resolvers worldwide, and that is simply slower
// than any impatience threshold worth having.
const SLOW_ATTEMPTS = 30;

/** The long watch: after the ten patient minutes are spent, keep asking every five for half a day.
 *  Tailscale publishes funnel hostnames on its own schedule — reports of hours are common — so the
 *  only alternatives to this are lying about the state or making the user poll by hand. */
async function watchForever(url, log, stillMine) {
  const EVERY = 5 * 60_000, UNTIL = 12 * 60 * 60_000;
  for (let waited = 0; waited < UNTIL; waited += EVERY) {
    await new Promise(r => setTimeout(r, EVERY));
    if (!stillMine()) return false;
    try {
      await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12_000) });
      log(`tunnel became reachable after ${Math.round((waited + EVERY) / 60_000)} more minutes`);
      return true;
    } catch { /* still nothing; that is the normal case here */ }
  }
  log('tunnel never became reachable within twelve hours — giving up the watch');
  return false;
}

/** Tell the user, wherever they are. The OS notification reaches them at this machine; the marker
 *  file is picked up by the backend, which owns the mail configuration and can write to them. */
function announceReady(stack, url) {
  try {
    fs.writeFileSync(path.join(stack.desktopDir, 'tunnel-ready.json'), JSON.stringify({ url, at: new Date().toISOString() }), 'utf8');
  } catch (e) { log(`could not hand the ready marker to the backend: ${e}`); }
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Dein Handy kann jetzt verbinden',
        body: 'Die Adresse ist online. Öffne "Handy verbinden" für den QR-Code.',
      });
      n.on('click', () => { if (win) { win.show(); win.focus(); } });
      n.show();
    }
  } catch (e) { log(`notification failed: ${e}`); }
  log(`tunnel ready announced: ${url}`);
}

async function keepTryingQuietly(url, log, onAttempt) {
  for (let attempt = 1; attempt <= SLOW_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, 20_000));
    onAttempt?.(attempt, SLOW_ATTEMPTS);
    try { await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12_000) }); return true; }
    catch (e) { log(`tunnel propagation attempt ${attempt}: ${String(e?.cause?.code || e?.message || e)}`); }
  }
  return false;
}

async function verifyPubliclyReachable(url, log, onAttempt) {
  for (let attempt = 1; attempt <= REACH_ATTEMPTS; attempt++) {
    // ⚠️ Report the attempt, always. A fresh funnel name has to reach public DNS and get a
    // certificate issued, so the honest worst case here is ~3½ minutes — and a spinner with no
    // number on it is indistinguishable from a hang. The user waits happily if they can see
    // progress; they reinstall the app if they cannot.
    onAttempt?.(attempt, REACH_ATTEMPTS);
    try {
      // Any HTTP answer proves the name resolves and the funnel terminates somewhere real; the
      // status code is the app's business, not ours.
      await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12_000) });
      return { ok: true };
    } catch (e) {
      const msg = String(e?.cause?.code || e?.message || e);
      log(`tunnel reachability attempt ${attempt}: ${msg}`);
      // ENOTFOUND/EAI_AGAIN = the name is not in public DNS → the HTTPS switch, not a slow network.
      if (attempt === REACH_ATTEMPTS) return { ok: false, dns: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg), detail: msg.slice(0, 200) };
      await new Promise(r => setTimeout(r, attempt * 4000));
    }
  }
  return { ok: false };
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

      // "up" from the sidecar means "permitted", not "reachable" — check before we hand the user
      // a QR code. Show the checking state meanwhile so the dialog is never silently stuck.
      if (e.state === 'up' && e.url) {
        // ⚠️ "up" can be announced twice: once when the funnel starts serving, and again when the
        // certificate arrives afterwards (the address only becomes resolvable then). Without a
        // generation guard both probes run at once — and the OLDER one still believes there is no
        // certificate, so when it gives up it writes "enable HTTPS in your account" over the newer,
        // correct verdict. Observed in the log: two interleaved attempt counters. Last writer wins,
        // and the last writer was the one that knew least.
        const gen = ++probeGen;
        const current = () => tunnel && gen === probeGen;
        writeTunnelStatus(stack.desktopDir, { state: 'verifying', url: e.url, attempt: 1, attempts: REACH_ATTEMPTS });
        void verifyPubliclyReachable(e.url, log, (attempt, attempts) => {
          if (current()) writeTunnelStatus(stack.desktopDir, { state: 'verifying', url: e.url, attempt, attempts });
        }).then(async res => {
          if (!current()) { log(`tunnel probe #${gen} superseded — dropping its verdict`); return; }
          if (res.ok) return writeTunnelStatus(stack.desktopDir, e);

          // ⚠️ Do NOT accuse the tailnet settings when the node HAS its certificate. Tailscale
          // only issues one if HTTPS is enabled there, so a cert in hand proves the setting is on
          // and the failure is a slow DNS record, not a missing switch. Guessing otherwise sent a
          // user into the admin console after a setting that was already enabled — and the console
          // is where every bad afternoon of this project has started.
          if (e.certOk) {
            writeTunnelStatus(stack.desktopDir, { state: 'propagating', url: e.url, attempt: 0, attempts: SLOW_ATTEMPTS });
            const arrived = await keepTryingQuietly(e.url, log, (attempt, attempts) => {
              if (current()) writeTunnelStatus(stack.desktopDir, { state: 'propagating', url: e.url, attempt, attempts });
            });
            if (!current()) return;
            if (arrived) return writeTunnelStatus(stack.desktopDir, { state: 'up', url: e.url });
            // ⚠️ Still nothing after ten more minutes — and the certificate still proves the
            // settings are right. Falling through here would have restored the very accusation
            // this whole branch exists to prevent. Observed in the field, verified against ts.net's
            // own authoritative nameservers: funnel serving, certificate issued, and the hostname
            // simply never published. That is Tailscale's side, and saying so is the honest end.
            writeTunnelStatus(stack.desktopDir, { state: 'not_published', url: e.url, detail: res.detail });
            // Waiting is unavoidable; sitting in front of it is not. Keep checking quietly for
            // hours, and when the address finally answers, say so where the user actually is —
            // an OS notification here, and a mail from the backend if they set SMTP up. No
            // restart, no "try again" ritual: the panel is driven by this same status file.
            const answered = await watchForever(e.url, log, () => current());
            if (!current() || !answered) return;
            writeTunnelStatus(stack.desktopDir, { state: 'up', url: e.url });
            announceReady(stack, e.url);
            return;
          }
          writeTunnelStatus(stack.desktopDir, {
            state: res.dns ? 'needs_https' : 'unreachable',
            url: e.url,
            helpUrl: 'https://login.tailscale.com/admin/dns',
            detail: res.detail,
          });
        });
        return;
      }
      writeTunnelStatus(stack.desktopDir, e);
    },
  });
}

/** Shut the stack down exactly once, from wherever the app is leaving.
 *
 *  ⚠️ There are two exits, and only one of them used to do this. `autoUpdater.quitAndInstall()`
 *  tears the app down on its own schedule, so the bundled Postgres was still running when the
 *  process went away — which is why every update left a stale postmaster.pid for the next start to
 *  clean up. Stopping deliberately here means the database closes properly on both paths. */
let shuttingDown = null;
function shutdownStack(s) {
  if (!s) return Promise.resolve();
  shuttingDown ??= (async () => {
    try { await stopTunnel(s); } catch (e) { log(`tunnel stop failed: ${e}`); }
    try { await s.stop(); } catch (e) { log(`stack stop failed: ${e}`); }
    log('stack stopped');
  })();
  return shuttingDown;
}

async function stopTunnel(stack) {
  const t = tunnel;
  tunnel = null;
  closeAuthWindow();
  if (t) { try { await t.stop(); } catch (e) { log(`tunnel stop failed: ${e}`); } }
  writeTunnelStatus(stack.desktopDir, { state: 'off' });
}

/** Forget this machine's tailnet login and start over.
 *
 *  The sign-in link Tailscale hands out is tied to the node key on disk and does not stay valid
 *  forever — and "forever" is easily reached by a first-timer, who may go and create a Google
 *  account, answer a survey, and come back ten minutes later. Until now the panel would keep
 *  offering that dead link, `stop`/`start` would hand back the same one (the state directory
 *  survives both), and the only real escape was reinstalling the app.
 *
 *  Wiping the state directory is what makes the next start hand out a FRESH link. It is safe:
 *  nothing in there is the user's data — it is this node's identity in a tailnet, which is exactly
 *  what they are asking to redo. The phone's saved address changes with it, which is why this is
 *  offered as an explicit way out and never done automatically. */
async function resetTunnel(stack) {
  await stopTunnel(stack);
  try {
    fs.rmSync(stack.tsnetDir, { recursive: true, force: true });
    log('tailnet state wiped — the next start will ask for a fresh sign-in');
  } catch (e) {
    log(`tailnet state wipe failed: ${e}`);
    writeTunnelStatus(stack.desktopDir, { state: 'error', reason: 'reset_failed', detail: String(e?.message || e) });
    return;
  }
  startTunnelFor(stack, { openLogin: true });
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
      .then(() => (action === 'stop' ? stopTunnel(stack)
                 : action === 'reset' ? resetTunnel(stack)
                 : startTunnelFor(stack, { openLogin: true })))
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
  // Both loopback spellings count as "us": the window runs on localhost (WebAuthn needs a domain,
  // not an IP) while plenty of internal links still say 127.0.0.1.
  const ours = (u) => u.startsWith(appOrigin) || u.startsWith('data:')
    || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):/.test(u);
  contents.on('will-navigate', (e, url) => {
    if (ours(url)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
}

/** Say something when the WINDOW breaks, and give the user a way out.
 *
 *  ⚠️ After an in-place update the window came up black — and the log had nothing to say, because
 *  it only ever recorded the backend. A renderer that dies, fails to load or hangs is invisible
 *  from the main process unless you ask, and "black screen" is then all anyone can report. Ask.
 *
 *  The reload accelerator matters for the same reason: removing the menu bar (this is an appliance,
 *  not a document editor) also removed Ctrl+R, so a blank window could only be escaped by quitting
 *  the whole app. Registered on the window, so it cannot leak into other applications. */
function watchRenderer(w) {
  const wc = w.webContents;
  wc.on('did-fail-load', (_e, code, desc, url) => log(`renderer failed to load: ${code} ${desc} (${url})`));
  wc.on('render-process-gone', (_e, details) => {
    log(`RENDERER GONE: ${details?.reason} (exitCode ${details?.exitCode}) — reloading`);
    try { wc.reload(); } catch (e) { log(`reload after crash failed: ${e}`); }
  });
  wc.on('unresponsive', () => log('renderer unresponsive'));
  // ⚠️ The renderer's console is the ONLY place a React render error appears, and none of the
  // process-level events fire for it: the tree just unmounts and you get a blank window. That is
  // precisely how a black screen looked "unexplainable" for an hour — the page painted, then threw.
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log(`renderer console: ${message} (${String(sourceId).split('/').pop()}:${line})`);
  });
  wc.on('responsive', () => log('renderer responsive again'));
  w.on('focus', () => {
    for (const key of ['CommandOrControl+R', 'F5']) {
      try { globalShortcut.register(key, () => wc.reload()); } catch { /* another app may hold it */ }
    }
    // ⚠️ F12 opens the developer tools. A packaged Electron app has no menu bar and therefore no
    // way in — which is why a visual report ("there is still a scrollbar") could only be answered
    // by rebuilding the situation here and hoping it matched. One keystroke turns a description
    // into a measurement. Third diagnostic gap closed today, and the cheapest of them.
    try { globalShortcut.register('F12', () => wc.toggleDevTools()); } catch { /* held elsewhere */ }
  });
  w.on('blur', () => globalShortcut.unregisterAll());
}

async function start() {
  // Before anything expensive or visible: if we are running from the mounted disk image, put
  // ourselves into Applications and hand over to the copy. Doing it here rather than at module
  // load keeps dialogs legal (they need a ready app) and costs one filesystem check otherwise.
  if (await selfInstall({ app, dialog, log })) { app.quit(); return; }

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
  // ⚠️ WINDOWS ONLY — and that qualifier is the entire point. On Windows the bundled initdb exits 1
  // under a path containing a space, so a profile like "C:\Users\Max Mustermann" has to be reported
  // plainly instead of failing three steps later with an empty error.
  //
  // On macOS the standard data directory is ~/Library/Application Support/… — a space nobody can
  // avoid. So this guard refused to start on EVERY Mac, before anything else ran: the app could
  // never have worked there, signature or no signature. Measured on a real Mac Studio (macOS 26.3,
  // arm64) with the binary out of this very bundle: initdb creates a cluster in
  // "/tmp/vds test mit leerzeichen/data" without complaint. The limitation is Windows', not
  // Postgres', and stating it as a universal truth cost macOS every release so far.
  if (process.platform === 'win32' && /\s/.test(dataDir)) {
    throw new Error(`Der Datenpfad enthält ein Leerzeichen, damit kommt die mitgelieferte Datenbank nicht zurecht:\n${dataDir}`);
  }

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
  // Which of the three situations is this? A cluster that already exists means it is not a first
  // run; a version that differs from last time means we just updated, and THAT start is slow again
  // because the new release runs its database migrations. Saying "einen Moment" while that happens
  // is how a 40-second wait looks like a hang.
  const stamp = path.join(dataDir, 'last-version');
  const firstRun = !fs.existsSync(path.join(dataDir, 'pgdata', 'PG_VERSION'));
  let previous = null;
  try { previous = fs.readFileSync(stamp, 'utf8').trim(); } catch { /* first run, or never written */ }
  const updated = !firstRun && !!previous && previous !== app.getVersion();
  try { fs.writeFileSync(stamp, app.getVersion()); } catch { /* not fatal */ }
  log(`splash mode: ${firstRun ? 'first' : updated ? `updated (${previous} → ${app.getVersion()})` : 'normal'}`);
  await win.loadURL(splashUrl(firstRun ? 'first' : updated ? 'updated' : 'normal'));

  // One automatic retry. The first launch after an install has been seen to leave the database
  // half-started; restarting the app by hand fixed it, so do that FOR the user instead of
  // handing them a dead window.
  // ⚠️ DREI Versuche, und der try umfasst boot() selbst. Bisher fing diese Schleife nur den Fall
  // "Backend kam nicht hoch" — warf boot() dagegen (Postgres startet nicht), flog die Ausnahme an
  // der Schleife vorbei direkt in den Fehlerdialog. Genau das passierte einem Nutzer, der die App
  // schloss und sechs Sekunden später wieder öffnete: ein Zustand, der sich von selbst löst,
  // beendete die App endgültig.
  let letzterFehler = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
   try {
    stack = await boot({
      dataDir,
      backendEntry,
      // Where the bundled sidecars live once packaged; null in a dev checkout, where boot falls
      // back to the repo layout.
      resourcesPath: app.isPackaged ? process.resourcesPath : null,
      log,
      // No fixed port — boot picks a free one (a stray server on 8899 must not break us).
      // Electron forks Node via utilityProcess so the child uses Electron's runtime, not a system node.
      forker: (entry, env) => utilityProcess.fork(entry, [], { env, stdio: 'inherit' }),
    });
    log(`backend booting on ${stack.url} (attempt ${attempt})`);
    if (attempt === 1) watchForUpdateRequest(stack.updaterDir);

    if (await waitForBackend(stack.url)) {
      log('backend ready — loading UI');
      keepLinksInTheBrowser(win.webContents, stack.url);
      watchRenderer(win);
      // Only now: the bridge needs the port of the backend that actually came up (a retry picks a
      // new one), and a tunnel pointed at the failed attempt would proxy to nothing.
      watchDesktopBridge(stack);
      await loadWithRetry(win, stack.url);
      return;
    }

    log(`backend did not come up on attempt ${attempt}`);
   } catch (e) {
    // embedded-postgres rejects with `undefined` on failure, so the error alone says nothing.
    // Collect what the machine can still tell us instead of writing "unknown error" into a log
    // the user is then asked to send us.
    letzterFehler = e;
    log(`start attempt ${attempt} failed: ${describeBootFailure(e, dataDir)}`);
   }
    if (attempt < 3) {
      try { await stack?.stop(); } catch (e2) { log(`teardown before retry failed: ${e2}`); }
      stack = null;
      try { await win.loadURL(splashUrl('retry')); } catch { /* window may be gone */ }
      await new Promise(r => setTimeout(r, attempt * 3000));   // let the predecessor finish dying
    }
  }
  throw new Error('Die Datenbank ist auch beim dritten Versuch nicht gestartet.\n\n'
    + describeBootFailure(letzterFehler, dataDir));
}

/** What the user looks at while the app comes up. Inline data URL — no extra file to bundle, and
 *  it renders before anything else exists.
 *
 *  ⚠️ Three different situations, three different texts. Saying "the database is being created,
 *  this takes about a minute" on EVERY launch is both wrong and alarming: it is true exactly once,
 *  and a returning user reads it as "it is doing that again?". A normal start takes a few seconds
 *  and deserves nothing more than the product standing there calmly. */
function splashUrl(mode = 'normal') {
  const line = mode === 'retry'
    ? 'Der erste Versuch hat nicht geklappt — die App probiert es gerade noch einmal.'
    : mode === 'first'
      ? 'Beim allerersten Start wird deine Datenbank angelegt. Das dauert etwa eine Minute — danach geht es immer schnell.'
      : mode === 'updated'
        ? 'Die neue Version richtet deine Daten ein. Das passiert nur nach einem Update und dauert einen Augenblick länger.'
        : 'einen Moment …';
  const head = mode === 'first' ? 'Vorratsdatenspeicher wird eingerichtet'
    : mode === 'updated' ? 'Vorratsdatenspeicher wurde aktualisiert'
    : 'Vorratsdatenspeicher';
  // The receipt is the product's own visual language (see the website): paper, a dashed tear-off
  // edge, monospace. Cheaper and better than a logo we cannot load from a data: URL.
  const html = `<!doctype html><meta charset="utf-8"><style>
    @keyframes p{0%{transform:translateX(-120%)}100%{transform:translateX(420%)}}
    @keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    *{box-sizing:border-box}
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#f4eee0;color:#2c2620;font:15px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
    .r{width:min(21rem,80vw);padding:26px 26px 22px;background:#fffdf7;border-radius:3px;
      box-shadow:0 1px 2px rgba(44,38,32,.06),0 8px 28px rgba(44,38,32,.10);
      animation:in .45s ease-out both;text-align:center;
      /* torn-off bottom edge */
      -webkit-mask:radial-gradient(6px at 6px 100%,#0000 98%,#000) -6px 0/12px 100% repeat-x;
      mask:radial-gradient(6px at 6px 100%,#0000 98%,#000) -6px 0/12px 100% repeat-x}
    h1{font-size:15px;font-weight:700;margin:0;letter-spacing:.06em;text-transform:uppercase}
    .rule{margin:14px 0;border-top:1px dashed #d9d0bb}
    p{margin:0;color:#6b6355;font-size:12.5px;letter-spacing:.01em}
    .bar{margin:18px auto 2px;width:150px;height:3px;background:#e7dfcb;border-radius:2px;overflow:hidden}
    .bar i{display:block;width:22%;height:100%;background:#3d6a4e;animation:p 1.5s ease-in-out infinite}
    </style><div class="r">
    <h1>${head}</h1>
    <div class="rule"></div>
    <p>${line}</p>
    <div class="bar"><i></i></div></div>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

/** Load the app into the window, and do not die of a sleeping laptop.
 *
 *  ⚠️ From a real user log: "renderer failed to load: -331 ERR_NETWORK_IO_SUSPENDED", and one
 *  second later FATAL. That code means the OS suspended network I/O — the machine went to standby
 *  mid-load. Closing a lid is not a fault, but it ended the app, and the user was then asked to
 *  send in a log. These codes describe a MOMENT, not a broken install, so we wait the moment out.
 *
 *  Anything else — a genuinely dead backend — still throws on the last try, where it belongs. */
async function loadWithRetry(fenster, url, versuche = 5) {
  const voruebergehend = /ERR_NETWORK_IO_SUSPENDED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_ABORTED/;
  for (let i = 1; i <= versuche; i++) {
    try { return await fenster.loadURL(url); }
    catch (e) {
      const text = String(e?.message ?? e);
      if (i === versuche || !voruebergehend.test(text)) throw e;
      log(`loading the UI failed (${text.split("(")[0].trim()}) — retry ${i}/${versuche - 1} in 2s`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
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
process.on('unhandledRejection', (e) => {
  // ⚠️ Known and harmless: embedded-postgres registers its own process-exit hook
  // (AsyncExitHook(gracefulShutdown)) and calls a `done` callback that the installed version of
  // async-exit-hook never passes — so shutting down always ended in a stack trace that looked like
  // a crash. We stop Postgres deliberately in shutdownStack() before this ever runs, so the hook
  // has nothing left to do. Log it in one line rather than letting it dominate the file.
  if (/done is not a function/.test(String(e?.message ?? ''))) {
    return log('embedded-postgres exit hook misfired (known beta bug) — database already stopped by us');
  }
  log(`unhandledRejection: ${(e && e.stack) || e}`);
});
process.on('uncaughtException', (e) => log(`uncaughtException: ${(e && e.stack) || e}`));

app.on('window-all-closed', () => app.quit());
app.on('before-quit', async (e) => {
  if (stack) {
    e.preventDefault();
    const s = stack; stack = null;
    // Tunnel first inside shutdownStack: leaving the node online after the backend is gone would
    // publish an HTTPS address that answers with connection-refused, which reads to a phone as
    // "the app is broken" rather than "the computer is off".
    await shutdownStack(s);
    app.exit(0);
  }
});
