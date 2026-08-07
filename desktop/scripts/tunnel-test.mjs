// Live test of the "Handy verbinden" path WITHOUT Electron: serve a marker page on a local port,
// run the shipped tunnel manager against the real sidecar, and then fetch the resulting public
// https://…ts.net URL from the outside. If the marker comes back, a phone scanning the QR would
// reach this machine — which is the only thing that actually proves the feature.
//
// Uses the existing tsnet-state (a completed login), so no auth window is needed. Not shipped.
//
//   node scripts/tunnel-test.mjs
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startTunnel, sidecarPath, hasTunnelState } from '../tunnel.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const tsnetDir = path.resolve(desktopRoot, 'tsnet-sidecar', 'tsnet-state');   // gitignored; persists login
const MARKER = 'VDS-TUNNEL-OK';

const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(MARKER); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`[test] marker server on 127.0.0.1:${port} · existing login: ${hasTunnelState(tsnetDir)}`);

const bin = sidecarPath({ resourcesPath: null, devRoot: desktopRoot });
console.log(`[test] sidecar: ${bin ?? 'NOT FOUND'}`);

let done = false;
const tunnel = startTunnel({
  localPort: port, stateDir: tsnetDir, binPath: bin, log: m => console.log(`[log] ${m}`),
  onEvent: async (e) => {
    console.log('[event]', JSON.stringify(e));
    if (e.state !== 'up' || done) return;
    done = true;
    try {
      const res = await fetch(e.url, { redirect: 'follow' });
      const body = (await res.text()).trim();
      console.log(`[test] GET ${e.url} → ${res.status} · body=${JSON.stringify(body.slice(0, 40))}`);
      console.log(body === MARKER ? '[test] ✅ PUBLIC URL REACHES THIS MACHINE' : '[test] ❌ wrong body');
    } catch (err) {
      console.log(`[test] ❌ public fetch failed: ${err?.message || err}`);
    }
    await tunnel.stop();
    server.close();
    process.exit(0);
  },
});

setTimeout(async () => { console.log('[test] timeout'); await tunnel.stop(); server.close(); process.exit(1); }, 180_000);
