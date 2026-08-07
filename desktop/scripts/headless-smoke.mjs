// Headless proof that the EXISTING backend runs against a BUNDLED Postgres (embedded-postgres,
// no Docker, no external server) — the make-or-break for the Electron direction. This runs the
// same boot.mjs the Electron shell uses, but forks the backend under plain Node instead of
// Electron's utilityProcess, so it works in CI / a terminal with no display.
//
// Usage: node scripts/headless-smoke.mjs [dataDir]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { boot, resolveSecrets } from '../boot.mjs';
import { findTailscale } from '../tunnel.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendEntry = path.resolve(__dirname, '..', '..', 'backend', 'dist', 'index.js');
const dataDir = process.argv[2] || path.resolve(__dirname, '..', '.smoke-data');

async function waitFor(base, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${base}/api/version`); if (r.ok) return await r.json(); } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('backend never became ready');
}

let stack;
try {
  // Secrets must be stable across boots (else every restart silently logs everyone out).
  const secDir = path.resolve(__dirname, '..', '.smoke-secrets');
  rmSync(secDir, { recursive: true, force: true });
  const s1 = resolveSecrets(secDir);
  const s2 = resolveSecrets(secDir);
  const okSecrets = s1.jwt === s2.jwt && s1.internal === s2.internal && s1.jwt.length === 64;
  console.log('[smoke] secret persistence →', okSecrets ? 'OK (stable across boots)' : 'FAIL');
  rmSync(secDir, { recursive: true, force: true });

  console.log('[smoke] starting bundled Postgres + backend (no Docker) …');
  // Free ports (no fixed 8899/54329 — those can collide with whatever else is running).
  // tunnel:false so the test never starts a real Funnel on a machine that happens to run Tailscale.
  stack = await boot({ dataDir, backendEntry, tunnel: false });
  console.log('[smoke] chose port', stack.port);

  const version = await waitFor(stack.url);
  console.log('[smoke] /api/version →', JSON.stringify(version));

  const opt = await fetch(`${stack.url}/api/auth/passkey/login/options`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(r => r.json());
  const okPasskey = !!(opt?.options?.challenge && opt?.challengeId);
  console.log('[smoke] passkey login/options →', okPasskey ? 'OK (challenge issued)' : JSON.stringify(opt));

  const gate = await fetch(`${stack.url}/api/auth/passkey/register/options`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  console.log('[smoke] register/options without token →', gate.status, gate.status === 401 ? 'OK (auth-gated)' : 'UNEXPECTED');

  // The Electron window loads "/", so the backend must serve the built SPA (not just the API).
  const html = await fetch(stack.url).then(r => r.text()).catch(() => '');
  const okSpa = /<div id="root"|<!doctype html/i.test(html);
  console.log('[smoke] GET / (SPA) →', okSpa ? 'OK (index.html served)' : 'NOT SERVED');

  // Informational: whether this machine could serve a Tailscale Funnel (not asserted — needs a tailnet login).
  console.log('[smoke] tailscale present →', findTailscale() ? 'yes (funnel possible)' : 'no (runs local-only)');

  const pass = okSecrets && version?.node && okPasskey && gate.status === 401 && okSpa;
  console.log(pass ? '\n[smoke] ✅ PASS — backend boots on bundled Postgres and serves the app'
                   : '\n[smoke] ❌ FAIL');
  await stack.stop();
  // Fresh cluster each run so the proof is reproducible.
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('[smoke] error:', e);
  try { await stack?.stop(); } catch { /* ignore */ }
  process.exit(1);
}
