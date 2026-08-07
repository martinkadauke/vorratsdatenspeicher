import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startFunnel } from './tunnel.mjs';

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
  const { dataDir, backendEntry, appPort = 8899, pgPort = 54329, secrets, forker } = opts;
  const pgDataDir = path.join(dataDir, 'pgdata');

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
  const env = {
    ...process.env,
    DATABASE_URL: `postgres://vds:vds@127.0.0.1:${pgPort}/vorratsdatenspeicher`,
    PORT: String(appPort),
    JWT_SECRET: jwt,
    INTERNAL_SECRET: internal,
    MIGRATIONS_DIR: path.join(backendRoot, 'migrations'),
    // Serve the built SPA so the window shows the app, not just the API. In dev that's
    // frontend/dist; a packaged build points this at the bundled frontend.
    PUBLIC_DIR: opts.publicDir || path.resolve(backendRoot, '..', 'frontend', 'dist'),
    // never DEMO on the desktop — single household, no RLS/two-role topology.
    DEMO_MODE: '',
  };

  const child = (forker ?? spawnNode)(backendEntry, env);

  // Optional public exposure via Tailscale Funnel (stable HTTPS → remote phone + PWA + passkeys).
  // Absent / not-logged-in → the app still runs locally; `tunnel.available` reports why.
  const tunnel = opts.tunnel === false
    ? { available: false, reason: 'disabled', url: null, host: null, stop: async () => {} }
    : await startFunnel(appPort).catch(() => ({ available: false, reason: 'error', url: null, host: null, stop: async () => {} }));

  return {
    port: appPort,
    url: `http://127.0.0.1:${appPort}`,
    tunnel,                       // { available, reason, url, host, stop }
    publicUrl: tunnel.url,        // the HTTPS URL to encode in the connect-phone QR, or null
    async stop() {
      try { await tunnel.stop(); } catch { /* best effort */ }
      try { child.kill(); } catch { /* already gone */ }
      try { await pg.stop(); } catch { /* already stopped */ }
    },
  };
}

/** Default forker for non-Electron contexts (the headless smoke): run the backend under Node. */
function spawnNode(entry, env) {
  return spawn(process.execPath, [entry], { env, stdio: 'inherit' });
}
