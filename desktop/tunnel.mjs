import { spawn, execFileSync } from 'node:child_process';

// Expose the local desktop instance to the internet via **Tailscale Funnel** — a stable
// HTTPS `*.ts.net` URL with a real certificate. That's what makes remote phone access work
// AND what unlocks PWA install + passkeys (both need a secure context). Tailscale terminates
// TLS on THIS machine and only relays encrypted bytes, so the developer never touches the
// user's traffic (why Funnel beats a Cloudflare tunnel here). Requires a one-time, free
// tailnet login on the admin's machine (guided in the setup wizard).
//
// Everything degrades gracefully: no tailscale binary, or not logged in → returns null and
// the desktop app still runs locally.

const WIN_PATHS = ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'];
const NIX_PATHS = ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

/** Locate the tailscale CLI, or null if it isn't installed. */
export function findTailscale() {
  for (const c of (process.platform === 'win32' ? WIN_PATHS : NIX_PATHS)) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
  }
  return null;
}

/** The tailnet is up + logged in → return this node's MagicDNS host (no trailing dot), else null. */
function funnelHost(bin) {
  try {
    const status = JSON.parse(execFileSync(bin, ['status', '--json'], { encoding: 'utf8' }));
    if (status?.BackendState !== 'Running') return null;
    const host = status?.Self?.DNSName?.replace(/\.$/, '');
    return host || null;
  } catch { return null; }
}

/**
 * Start Funnel for `localPort`. Returns { url, host, stop } on success, or null when Tailscale
 * is unavailable/not logged in (the caller then runs local-only).
 */
export async function startFunnel(localPort, opts = {}) {
  const bin = opts.bin || findTailscale();
  if (!bin) return { available: false, reason: 'not_installed', url: null, host: null, stop: async () => {} };
  const host = funnelHost(bin);
  if (!host) return { available: false, reason: 'not_logged_in', url: null, host: null, stop: async () => {} };

  // `tailscale funnel --bg <port>` proxies https://<host>/ → 127.0.0.1:<port> in the background.
  // CLI syntax has shifted across versions — validate on a real tailnet before shipping.
  let proc = null;
  try {
    proc = spawn(bin, ['funnel', '--bg', String(localPort)], { stdio: 'ignore' });
  } catch {
    return { available: false, reason: 'funnel_start_failed', url: null, host, stop: async () => {} };
  }

  return {
    available: true,
    reason: 'ok',
    host,
    url: `https://${host}`,
    async stop() {
      try { execFileSync(bin, ['funnel', 'off'], { stdio: 'ignore' }); } catch { /* best effort */ }
      try { proc?.kill(); } catch { /* already gone */ }
    },
  };
}
