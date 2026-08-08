import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Expose the local desktop instance to the internet via **Tailscale Funnel** — a stable HTTPS
// `*.ts.net` URL with a real certificate. That is what makes remote phone access work AND what
// unlocks PWA install + passkeys (both need a secure context). TLS terminates on THIS machine and
// Tailscale only relays ciphertext, so the developer never touches the user's traffic (why Funnel
// beats a Cloudflare tunnel here).
//
// ⚠️ This drives the BUNDLED tsnet sidecar, not a system `tailscale` install. That was the whole
// point of the embedded-node route: one installer, no second setup, no OS admin prompt. An earlier
// version of this file shelled out to the tailscale CLI — it required the user to install and
// configure Tailscale first, which is exactly the Docker-shaped friction the desktop build exists
// to remove.
//
// Everything degrades gracefully: no sidecar binary, or the user never logs in → the app runs
// local-only and `reason` says why.

/** The sidecar's user-visible name. It shows up in the Windows firewall prompt and in macOS's
 *  "accept incoming connections" dialog, so it must read like the product, not like a binary. */
const BIN_BASE = 'Vorratsdatenspeicher Verbindung';
const BIN_NAME = process.platform === 'win32' ? `${BIN_BASE}.exe` : BIN_BASE;

/** Where the sidecar lives: next to the app in a packaged build, in its source dir in a dev run. */
export function sidecarPath({ resourcesPath, devRoot }) {
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'tsnet', BIN_NAME) : null,
    devRoot ? path.join(devRoot, 'tsnet-sidecar', 'bin', BIN_NAME) : null,   // where CI + `go build -o bin/` put it
    devRoot ? path.join(devRoot, 'tsnet-sidecar', BIN_NAME) : null,          // a hand-built binary next to main.go
  ].filter(Boolean);
  return candidates.find(existsSync) || null;
}

/** Has this install ever completed a tailnet login? (state dir non-empty → yes.) Lets the shell
 *  bring the tunnel back up by itself on later launches without ever prompting an unconnected
 *  user — nobody should be asked to create a Tailscale account by merely opening the app. */
export function hasTunnelState(stateDir) {
  try { return readdirSync(stateDir).length > 0; } catch { return false; }
}

/**
 * Start the tunnel. Returns immediately with a handle; progress arrives through `onEvent`:
 *   { state: 'starting' }                       spawned, talking to Tailscale
 *   { state: 'auth',    authUrl }               user must log in (shell opens this in-window)
 *   { state: 'connecting', url }                logged in, node up, funnel not serving yet
 *   { state: 'up',      url }                   reachable from the phone
 *   { state: 'needs_funnel', url, detail, helpUrl }   tailnet has Funnel switched off
 *   { state: 'error',   reason, detail }        binary missing / crashed
 *
 * @param {{ localPort:number, stateDir:string, binPath:string|null,
 *           onEvent:(e:object)=>void, log?:(m:string)=>void }} opts
 */
export function startTunnel({ localPort, stateDir, binPath, onEvent, log = () => {} }) {
  if (!binPath) {
    onEvent({ state: 'error', reason: 'sidecar_missing', detail: BIN_NAME });
    return { stop: async () => {} };
  }

  let url = null;
  let consentUrl = null;
  let consentText = null;
  let stopped = false;
  const child = spawn(binPath, [], {
    env: { ...process.env, VDS_LOCAL_PORT: String(localPort), TSNET_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'pipe'],   // stdin stays open on purpose: closing it tells the sidecar we died
    windowsHide: true,
  });
  onEvent({ state: 'starting' });
  let certOk = false;
  let funnelUp = false;
  let certAttempt = 0, certAttempts = 0;

  /** The consent link is the user's ONE action, so it outranks any progress we might show.
   *  QueryFeature reporting "not complete" is authoritative — we do not need to wait for the funnel
   *  to fail before saying so, and waiting is what stranded someone at "attempt 8 of 40" with the
   *  enabling button nowhere on screen. */
  /** ⚠️ STICKY. Once the tailnet has told us it is not ready, that stays on screen until the funnel
   *  actually comes up — because it names the user's next action, and nothing we are doing in the
   *  background is more important than that.
   *
   *  0.34 tied this to the presence of a one-click consent URL. When Tailscale did not hand one out,
   *  the card was emitted once by the funnel error and then overwritten fifteen seconds later by the
   *  next certificate tick, and again, and again — so the only thing a new user ever saw was a
   *  counter, with the enabling step blinking past once and vanishing. */
  let blocked = null;
  const emitBlocked = (extra = {}) => {
    blocked = { ...(blocked ?? { state: 'needs_funnel', url }), ...extra, url };
    onEvent({ ...blocked, attempt: certAttempt || undefined, attempts: certAttempts || undefined });
  };

  // The sidecar's contract is one `KEY=value` line per event. Buffer partial reads — a 40-line
  // Tailscale log burst arrives in arbitrary chunks and a split URL would be unopenable.
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim();
      // ⚠️ Log the raw event. Only stderr was recorded, so the sidecar's own account of what it
      // asked Tailscale and what came back — the decisive evidence every single time today — was
      // the one thing no bug report could contain.
      if (key.startsWith('VDS_')) log(`tunnel< ${key}=${val.slice(0, 300)}`);
      if (key === 'VDS_AUTH_URL') onEvent({ state: 'auth', authUrl: val });
      else if (key === 'VDS_PUBLIC_URL') { url = val; onEvent({ state: 'connecting', url }); }
      // Whether the node got its own certificate is the one HONEST answer to "does this tailnet
      // permit HTTPS". Without it the shell can only guess from a failed probe — and it guessed
      // wrong, telling people to switch on a setting that was already on.
      else if (key === 'VDS_CERT') {
        if (val === 'ok') {
          certOk = true;
          // The funnel may well have come up before the certificate did. Re-announce so the shell
          // probes again — the address only becomes resolvable once the certificate exists.
          if (funnelUp) onEvent({ state: 'up', url, certOk });
        } else {
          // Issuance is retried for ~10 minutes because it can only succeed AFTER the user grants
          // consent. Show the count — but never INSTEAD of the button that ends the waiting.
          const m = /requesting (\d+)\/(\d+)/.exec(val);
          if (m) {
            certAttempt = Number(m[1]); certAttempts = Number(m[2]);
            // Progress never replaces an outstanding instruction; it rides along inside it.
            if (blocked && !funnelUp) emitBlocked();
            else onEvent({ state: 'cert', url, attempt: certAttempt, attempts: certAttempts });
          }
        }
      }
      else if (key === 'VDS_CERT_ERR') certOk = false;
      else if (key === 'VDS_FUNNEL' && val === 'up') { funnelUp = true; blocked = null; onEvent({ state: 'up', url, certOk }); }
      // Tailscale's own one-click consent page: enables BOTH tailnet prerequisites at once.
      // Shown the moment we have it — a tailnet that is already set up never produces one.
      else if (key === 'VDS_CONSENT_URL') {
        consentUrl = val;
        if (!funnelUp) emitBlocked({ helpUrl: consentUrl, oneClick: true, consentText });
      }
      else if (key === 'VDS_CONSENT_TEXT') consentText = val;
      // Tailscale could not tell us what this tailnet is missing. Not fatal — the funnel error
      // below still carries a deep link — but it is the difference between one click and a guided
      // detour, so it must reach the log instead of vanishing.
      else if (key === 'VDS_CONSENT_ERR') log(`tunnel: consent query failed: ${val.slice(0, 200)}`);
      else if (key === 'VDS_FUNNEL_ERR') {
        onEvent({
          state: 'needs_funnel',
          url,
          detail: val.slice(0, 300),
          // Prefer the consent link — one click, both requirements, no admin-console navigation.
          // The old deep link stays as the fallback for a tailnet where QueryFeature said nothing.
          helpUrl: consentUrl || funnelHelpUrl(val),
          oneClick: !!consentUrl,
          consentText: consentText || undefined,
        });
      }
    }
  });
  // Not an event channel — but the only place a Go panic or a Tailscale complaint shows up, and
  // "the tunnel silently did nothing" is the hardest thing to debug from a user's report.
  child.stderr.on('data', (c) => log(`tunnel: ${c.toString().trim()}`));

  child.on('exit', (code, signal) => {
    if (stopped) return;
    onEvent({ state: 'error', reason: 'sidecar_exited', detail: `code=${code} signal=${signal}` });
  });
  child.on('error', (e) => onEvent({ state: 'error', reason: 'sidecar_spawn_failed', detail: String(e?.message || e) }));

  return {
    async stop() {
      stopped = true;
      // Closing stdin is the sidecar's own shutdown signal (it exits on EOF) and lets it take the
      // node offline cleanly; the kill is the fallback for a wedged process.
      try { child.stdin.end(); } catch { /* already gone */ }
      await new Promise((r) => {
        const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } r(); }, 3000);
        child.once('exit', () => { clearTimeout(t); r(); });
      });
    },
  };
}

/** Tailscale's own error text carries the admin-console URL that enables Funnel. Pull it out so
 *  the UI can offer one link instead of asking the user to read a Go error. */
function funnelHelpUrl(detail) {
  const m = /https:\/\/login\.tailscale\.com\/[^\s"']+/.exec(detail || '');
  return m ? m[0] : 'https://login.tailscale.com/admin/dns';
}
