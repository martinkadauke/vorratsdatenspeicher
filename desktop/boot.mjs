import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bundlePath, startSearxng, selfTest } from './searxng.mjs';

/** Ask the OS for a free localhost port (avoids colliding with whatever else the user runs). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** Can we still have the port we used last time? */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * The app's port, STABLE across restarts. A fresh free port every launch looked harmless but
 * quietly broke everything that stores a URL: the password-reset mail, invite links, a browser
 * bookmark, an installed PWA — all of them pointed at a port that no longer existed by the time
 * anyone clicked. So: remember the port, reuse it whenever it is still available, and only move on
 * if something else took it (still never a hardcoded port — a stray server must not lock us out).
 */
async function stablePort(dataDir) {
  const file = path.join(dataDir, 'port.json');
  try {
    const { port } = JSON.parse(readFileSync(file, 'utf8'));
    if (Number.isInteger(port) && await portFree(port)) return port;
  } catch { /* first run, or the file is unreadable → pick a fresh one */ }
  const port = await freePort();
  try { mkdirSync(dataDir, { recursive: true }); writeFileSync(file, JSON.stringify({ port })); } catch { /* not fatal */ }
  return port;
}

/** Is a PID currently alive? (signal 0 probes without killing; EPERM means alive-but-not-ours.) */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * The app's JWT + internal secrets, generated once per install and persisted in dataDir so
 * logins survive restarts (random-per-boot would silently log everyone out on every launch).
 * A caller override (e.g. tests) wins.
 */
export function resolveSecrets(dataDir, override) {
  if (override?.jwt && override?.internal) return { jwt: override.jwt, internal: override.internal };
  const file = path.join(dataDir, 'secrets.json');
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    if (s.jwt && s.internal) return { jwt: s.jwt, internal: s.internal };
  } catch { /* generate + persist below */ }
  const fresh = { jwt: crypto.randomBytes(32).toString('hex'), internal: crypto.randomBytes(32).toString('hex') };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 });
  return fresh;
}

/**
 * Boot the VDS stack WITHOUT Docker — the desktop equivalent of docker-compose:
 *   1. start a bundled Postgres (embedded-postgres → a real PG binary, no external server)
 *   2. fork the EXISTING backend (backend/dist/index.js) pointed at it
 *   3. (caller opens a window at http://127.0.0.1:<appPort>)
 *
 * The backend is byte-for-byte the same code the Docker image runs; only DATABASE_URL differs.
 * `forker` is injected so the Electron main process can use utilityProcess.fork (Electron's
 * bundled Node) while the headless smoke uses child_process.spawn(node). searxng would be a
 * second sidecar started here the same way — deferred for the boot PoC.
 *
 * @param {{ dataDir: string, backendEntry: string, appPort?: number, pgPort?: number,
 *           secrets?: { jwt: string, internal: string }, forker?: (entry:string, env:object)=>any }} opts
 */
export async function boot(opts) {
  const { dataDir, backendEntry, secrets, forker } = opts;
  // Free ports by default — a fixed port collides with whatever else the user runs (a stray
  // python -m http.server on 8899 is exactly what bit us). The window/tunnel use stack.port.
  const appPort = opts.appPort || await stablePort(dataDir);
  const pgPort = opts.pgPort || await freePort();
  const pgDataDir = path.join(dataDir, 'pgdata');

  // A hard kill / crash leaves a stale postmaster.pid that makes Postgres refuse to start
  // ("lock file already exists"). If the PID it names is dead, the lock is stale → remove it.
  // If a live process still holds the data dir, leave it (don't stomp a running DB).
  const pidFile = path.join(pgDataDir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    const pid = parseInt((readFileSync(pidFile, 'utf8').split('\n')[0] || '').trim(), 10);
    if (!Number.isFinite(pid) || !pidAlive(pid)) rmSync(pidFile, { force: true });
  }

  const pg = new EmbeddedPostgres({
    databaseDir: pgDataDir,
    user: 'vds',
    password: 'vds',
    port: pgPort,
    persistent: true,
    // MUST be UTF8 — VDS's SQL + data carry umlauts, emoji and box-drawing chars. On Windows
    // initdb otherwise defaults to the OS locale (e.g. WIN1252), which can't represent them.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  // initdb only on first run; a persistent cluster is reused across restarts (data survives).
  const fresh = !existsSync(path.join(pgDataDir, 'PG_VERSION'));
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) {
    try { await pg.createDatabase('vorratsdatenspeicher'); } catch { /* already exists */ }
  }

  // Generated once and persisted per install so logins survive restarts.
  const { jwt, internal } = resolveSecrets(dataDir, secrets);

  // backendEntry = <backendRoot>/dist/index.js → migrations live at <backendRoot>/migrations.
  // The forked child's cwd is not the backend root, so point migrate() at them explicitly.
  const backendRoot = path.dirname(path.dirname(backendEntry));
  // Writable, per-install locations for everything the container would get as a mounted volume.
  // Created up front: the backend only checks existsSync and silently disables photo serving.
  const receiptsDir = path.join(dataDir, 'receipts');
  const updaterDir = path.join(dataDir, 'updater');
  // The shell↔backend bridge. The backend cannot spawn a Tailscale node (and must not be able to),
  // and the frontend is a plain web app with no Electron API — so "Handy verbinden" is a request
  // FILE the shell watches, answered by a status FILE the backend reads back. Deliberately the same
  // shape as the self-update marker: one mechanism, and the web UI stays identical in both channels.
  const desktopDir = path.join(dataDir, 'desktop');
  const tsnetDir = path.join(dataDir, 'tsnet');
  const searxngDir = path.join(dataDir, 'searxng');
  mkdirSync(receiptsDir, { recursive: true });
  mkdirSync(updaterDir, { recursive: true });
  mkdirSync(desktopDir, { recursive: true });
  mkdirSync(tsnetDir, { recursive: true });
  mkdirSync(searxngDir, { recursive: true });

  // The bundled web search. Started here beside Postgres because it is the same kind of thing: a
  // service the container gets from docker-compose and the desktop has to bring along itself.
  // Opt-out via `searxng: false` (the smoke, which must not spend a minute booting a scraper).
  const searxngBundle = opts.searxng === false ? null : bundlePath({
    resourcesPath: opts.resourcesPath ?? null,
    devRoot: path.dirname(fileURLToPath(import.meta.url)),
  });
  const searxngPort = searxngBundle ? await freePort() : 0;
  const searxng = searxngBundle
    ? startSearxng({ stateDir: searxngDir, bundleDir: searxngBundle, port: searxngPort, log: opts.log })
    : null;
  // ⚠️ Not blocking. SearXNG needs a few seconds to load its engines and nothing the user does in
  // that time needs it — but the result must reach the log, because a bundle that starts and
  // returns nothing is otherwise indistinguishable from one that works.
  if (searxng) void selfTest(searxng.url, opts.log ?? (() => {}));
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://vds:vds@127.0.0.1:${pgPort}/vorratsdatenspeicher`,
    PORT: String(appPort),
    JWT_SECRET: jwt,
    INTERNAL_SECRET: internal,
    MIGRATIONS_DIR: path.join(backendRoot, 'migrations'),
    // ⚠️ Receipt photos default to the DOCKER path `/receipts` — on Windows that resolves to
    // C:\receipts, which does not exist and cannot be created without admin, so every photo
    // upload failed ("Foto speichern fehlgeschlagen") and photo serving switched itself off.
    // Same failure family as the spaced data dir: a container-only absolute path leaking into
    // the desktop build. Keep them beside the database, inside the app's own data directory.
    RECEIPTS_LOCAL_PATH: receiptsDir,
    // Loopback only. Without this the app answered on every network interface, so anyone on the
    // same WLAN could open the household's receipts — the opposite of what a "runs on your own
    // computer" app should do. Reaching it from a phone is the tunnel's job, deliberately.
    BIND_HOST: '127.0.0.1',
    // Lets the in-app "Jetzt aktualisieren" button reach us: the backend drops a marker file
    // here and the Electron shell (main.mjs) picks it up. Same protocol as the Docker sidecar.
    SELF_UPDATE: '1',
    SELF_UPDATE_DIR: updaterDir,
    // Presence of this var is also how the app knows it is the DESKTOP build (the Docker image
    // never sets it) — it gates the "Handy verbinden" UI, which would be meaningless in a
    // container that is already reachable over the network.
    DESKTOP_DIR: desktopDir,
    // Serve the built SPA so the window shows the app, not just the API. In dev that's
    // frontend/dist; a packaged build points this at the bundled frontend.
    PUBLIC_DIR: opts.publicDir || path.resolve(backendRoot, '..', 'frontend', 'dist'),
    // The address of our own bundled search. A FACT of this build, not a setting — same reasoning
    // as DESKTOP_DIR and RECEIPTS_LOCAL_PATH: the port is chosen fresh at every boot, so storing it
    // in app_config would be stale the moment the app restarts. Absent when there is no bundle,
    // which the backend reads as "no web search" and skips quietly.
    ...(searxng ? { SEARXNG_URL: searxng.url } : {}),
    // never DEMO on the desktop — single household, no RLS/two-role topology.
    DEMO_MODE: '',
  };

  const child = (forker ?? spawnNode)(backendEntry, env);

  return {
    port: appPort,
    // ⚠️ The WINDOW must load the same origin the backend calls itself, or WebAuthn refuses:
    // the RP origin has to match exactly. `localhost` also happens to be the only loopback
    // spelling WebAuthn accepts as an RP ID (an IP literal is not a domain).
    url: `http://localhost:${appPort}`,
    receiptsDir,
    updaterDir,          // the shell watches this for the in-app update request
    desktopDir,          // …and this for the connect-phone request; it writes tunnel status back
    tsnetDir,            // the embedded Tailscale node's state (login persists across restarts)
    searxngUrl: searxng?.url ?? null,
    async stop() {
      try { child.kill(); } catch { /* already gone */ }
      try { searxng?.stop(); } catch { /* already gone */ }
      try { await pg.stop(); } catch { /* already stopped */ }
    },
  };
}

/** Default forker for non-Electron contexts (the headless smoke): run the backend under Node. */
function spawnNode(entry, env) {
  return spawn(process.execPath, [entry], { env, stdio: 'inherit' });
}
