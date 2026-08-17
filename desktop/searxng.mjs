import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// The bundled web search: an embedded SearXNG with its own CPython, assembled by
// desktop/searxng/build.sh and shipped in the installer beside the Postgres and Tailscale
// sidecars. A desktop user has no idea what SearXNG is; asking them for its address (as the
// Docker wizard does) would be asking about plumbing they never installed.
//
// What it buys, measured on a real instance over 27 days: 157 product pictures, 15 shop logos,
// and 11 canonical names the churner could not have worked out on its own. Without it those
// simply do not happen — the search client returns empty rather than throwing, so nothing breaks.

/** Where the assembled bundle lives: inside the packaged app's resources, or the repo in dev. */
export function bundlePath({ resourcesPath, devRoot }) {
  const dir = resourcesPath
    ? path.join(resourcesPath, 'searxng')
    // ⚠️ fileURLToPath, never URL.pathname: on Windows the latter yields "/C:/..." with a leading
    //    slash, which every fs call then fails on. Only reachable when a caller omits devRoot.
    : path.join(devRoot ?? path.dirname(fileURLToPath(import.meta.url)), 'searxng', 'bin');
  return fs.existsSync(path.join(dir, 'searx', 'webapp.py')) ? dir : null;
}

/** The interpreter inside the bundle. install_only layout differs per OS. */
function interpreter(dir) {
  const win = path.join(dir, 'python', 'python.exe');
  if (fs.existsSync(win)) return win;
  const nix = path.join(dir, 'python', 'bin', 'python3');
  return fs.existsSync(nix) ? nix : null;
}

/** ⚠️ Per INSTALL, never a constant. A secret_key baked into the installer would be the same on
 *  every machine on earth, which is the same as having none. Persisted so it survives restarts. */
function secretFor(stateDir) {
  const file = path.join(stateDir, 'secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* first run */ }
  const fresh = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}

/** Start the bundled search engine.
 *
 *  Returns null when there is no bundle — a dev checkout that never ran build.sh, or a build where
 *  the packaging step was skipped. That is a normal state, not an error: the backend's search
 *  client answers "not configured" and the app runs without pictures.
 *
 *  Never blocks: SearXNG takes a few seconds to load its engine list, and nothing the user does in
 *  that time needs it. */
export function startSearxng({ stateDir, bundleDir, port, log = () => {} }) {
  if (!bundleDir) { log('searxng: no bundle in this build — web search stays off'); return null; }
  const py = interpreter(bundleDir);
  if (!py) { log('searxng: bundle has no interpreter — web search stays off'); return null; }

  fs.mkdirSync(stateDir, { recursive: true });
  // The template ships with placeholders precisely so the real values are per-install and
  // per-boot: the key must not be shared, and the port is whatever was free this time.
  const template = fs.readFileSync(path.join(bundleDir, 'settings.yml'), 'utf8');
  const settings = path.join(stateDir, 'settings.yml');
  // ⚠️ GLOBAL. String.replace with a string pattern replaces the FIRST occurrence only — and the
  // template's own explanatory comment names both placeholders, so it ate them: the secret and the
  // port were substituted into a comment while the real settings kept "__PORT__", and SearXNG died
  // on int('__PORT__') at every launch. The comment explaining the substitution consumed it.
  const filled = template
    .replace(/__SECRET_KEY__/g, secretFor(stateDir))
    .replace(/__PORT__/g, String(port));
  // And prove it, because the failure mode is a config file that looks plausible: the process
  // starts, dies immediately, and the app reports "no search" with the reason four levels deep in
  // a Python traceback.
  if (/__[A-Z_]+__/.test(filled)) {
    log(`searxng: settings still contain a placeholder after substitution — refusing to start`);
    return null;
  }
  fs.writeFileSync(settings, filled, { mode: 0o600 });

  const child = spawn(py, ['-m', 'searx.webapp'], {
    cwd: stateDir,
    env: {
      ...process.env,
      // Flat directories on the path, not a venv: a venv bakes absolute paths and breaks the
      // moment the app is installed somewhere else.
      PYTHONPATH: `${path.join(bundleDir, 'lib')}${path.delimiter}${bundleDir}`,
      SEARXNG_SETTINGS_PATH: settings,
      PYTHONUNBUFFERED: '1',
      // ⚠️ THE APP MUST NEVER WRITE INSIDE ITS OWN BUNDLE. Python's default is to drop a
      // __pycache__ directory NEXT TO every module it imports — and PYTHONPATH above points
      // straight into the .app. On macOS the bundle is sealed by its code signature, so those
      // files break the seal, and the SECOND launch is refused by Gatekeeper with "is damaged
      // and can't be opened. You should move it to the Trash." An app that works once and then
      // tells the user to delete it. The prefix keeps the caches (and the startup speed they
      // buy) but puts the whole mirrored tree in our writable state directory instead.
      PYTHONPYCACHEPREFIX: path.join(stateDir, 'pycache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // ⚠️ Engines failing to register individually (brave 429, startpage captcha) is NORMAL — SearXNG
  // aggregates whatever answered. Only the process dying matters, so the noise is logged at all
  // but never treated as failure.
  // ⚠️ Per LINE, and generously. Slicing each CHUNK to 300 characters truncated the one thing that
  // mattered: a Python traceback arrives as a single chunk, so the exception type and message —
  // the last lines — were cut off, leaving only "Traceback (most recent call last)". Diagnosing
  // the placeholder bug above meant running the packaged bundle by hand to see an error the log
  // had already been handed.
  const tap = (s) => s.on('data', (c) => {
    for (const line of c.toString().split(/\r?\n/)) {
      if (line.trim()) log(`searxng: ${line.slice(0, 500)}`);
    }
  });
  tap(child.stdout); tap(child.stderr);
  child.on('exit', (code, signal) => log(`searxng: exited code=${code} signal=${signal}`));
  child.on('error', (e) => log(`searxng: could not start: ${e?.message ?? e}`));

  return {
    url: `http://127.0.0.1:${port}`,
    stop() { try { child.kill(); } catch { /* already gone */ } },
  };
}

/** Ask the running instance for one real answer.
 *
 *  ⚠️ This is the difference between "we ship a search engine" and "we ship a search engine that
 *  works". SearXNG is a scraper: when an engine changes its HTML the bundle keeps starting,
 *  answering, and returning NOTHING — and the backend now treats an empty result as a quiet skip,
 *  so the app just becomes silently worse. Shipping fixes fast is only useful if somebody notices,
 *  and nobody notices a thing that stopped happening. So: one query at boot, one line in the log,
 *  and a marker the backend can surface. */
export async function selfTest(url, log = () => {}) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/search?q=rewe&format=json`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const data = await res.json();
        const n = Array.isArray(data?.results) ? data.results.length : 0;
        log(n > 0
          ? `searxng: self-test OK — ${n} results`
          : 'searxng: self-test returned ZERO results — the bundle runs but every engine came back empty');
        return { ok: n > 0, results: n };
      }
    } catch { /* still starting up */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  log('searxng: self-test never got an answer within 60s');
  return { ok: false, results: 0 };
}
