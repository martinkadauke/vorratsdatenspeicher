// One-off live test of Option C: boot a real VDS backend, then run the compiled tsnet sidecar
// against it. The sidecar prints VDS_AUTH_URL (open + log in with Google), then VDS_PUBLIC_URL
// (the https://…ts.net address) + VDS_FUNNEL=up once Funnel serves. Not shipped — just proves the
// Tailscale login + Funnel end-to-end before we wire it into the window.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { boot } from '../boot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendEntry = path.resolve(__dirname, '..', '..', 'backend', 'dist', 'index.js');
const dataDir = path.resolve(__dirname, '..', '.smoke-data');                         // gitignored throwaway DB
const sidecar = path.resolve(__dirname, '..', 'tsnet-sidecar', 'Vorratsdatenspeicher Verbindung.exe');
const tsnetDir = path.resolve(__dirname, '..', 'tsnet-sidecar', 'tsnet-state');       // gitignored; persists login

console.log('[test] booting VDS backend (no boot-tunnel; the sidecar is the tunnel under test)…');
const stack = await boot({ dataDir, backendEntry, tunnel: false });
console.log('[test] VDS backend on port', stack.port);

console.log('[test] starting tsnet sidecar → watch for VDS_AUTH_URL …');
const sc = spawn(sidecar, [], {
  env: { ...process.env, VDS_LOCAL_PORT: String(stack.port), TSNET_DIR: tsnetDir, TS_HOSTNAME: 'vorratsdatenspeicher' },
  stdio: 'inherit',
});
sc.on('exit', c => console.log('[test] sidecar exited with', c));

process.on('SIGINT', async () => { try { sc.kill(); } catch {} try { await stack.stop(); } catch {} process.exit(0); });
await new Promise(() => {});   // stay alive
