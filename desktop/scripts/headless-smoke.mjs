// Headless proof that the EXISTING backend runs against a BUNDLED Postgres (embedded-postgres,
// no Docker, no external server) — the make-or-break for the Electron direction. This runs the
// same boot.mjs the Electron shell uses, but forks the backend under plain Node instead of
// Electron's utilityProcess, so it works in CI / a terminal with no display.
//
// Usage: node scripts/headless-smoke.mjs [dataDir]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { boot, resolveSecrets } from '../boot.mjs';
import { sidecarPath } from '../tunnel.mjs';

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

  // ── the "Handy verbinden" bridge ────────────────────────────────────────────────────────
  // The shell watches DESKTOP_DIR for a request file and writes the tunnel status back. Prove the
  // BACKEND half here: it must advertise itself as a desktop build, gate both endpoints behind an
  // operator token, and actually drop the marker the shell reacts to.
  const okDesktopFlag = version?.desktop === true;
  console.log('[smoke] /api/version desktop flag →', okDesktopFlag ? 'OK (true)' : 'MISSING');

  const anon = await fetch(`${stack.url}/api/desktop/tunnel`);
  console.log('[smoke] tunnel status without token →', anon.status, anon.status === 401 ? 'OK (auth-gated)' : 'UNEXPECTED');

  // First-run account creation is public on an instance with no users — that is how the desktop
  // app onboards its owner, so it doubles as the way to get an operator token here.
  const setup = await fetch(`${stack.url}/api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'smoke', password: 'smoke-pass-1234' }),
  }).then(r => r.json()).catch(() => ({}));
  const token = setup?.token;
  const auth = { Authorization: `Bearer ${token}` };

  const before = await fetch(`${stack.url}/api/desktop/tunnel`, { headers: auth }).then(r => r.json());
  console.log('[smoke] tunnel status →', JSON.stringify(before));
  const okStatus = before?.available === true && before?.state === 'off';

  await fetch(`${stack.url}/api/desktop/tunnel`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }),
  });
  const marker = path.join(stack.desktopDir, 'tunnel-request');
  const okMarker = existsSync(marker) && readFileSync(marker, 'utf8').trim() === 'start';
  console.log('[smoke] connect request →', okMarker ? 'OK (marker written for the shell)' : 'MARKER MISSING');

  // ── household members own the bank accounts ─────────────────────────────────────────────
  // A member is the PERSON; a login is optional (children, pets) and an account belongs to the
  // person, not to the login. Migration 110 moved ownership accordingly, so prove the chain:
  // member -> "das bin ich" -> user, and member <-> account as n:m.
  const mk = async (name) => (await fetch(`${stack.url}/api/family`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }).then(r => r.json())).id;
  const meId = await mk('SmokeMartin');
  const kidId = await mk('SmokeKind');

  await fetch(`${stack.url}/api/family/${meId}/thats-me`, { method: 'POST', headers: auth });
  const me = await fetch(`${stack.url}/api/family/me`, { headers: auth }).then(r => r.json());
  console.log('[smoke] "das bin ich" →', me?.member_id === meId ? 'OK' : `WRONG (${JSON.stringify(me)})`);

  // Moving it to another member must MOVE it, not fail on the unique index.
  await fetch(`${stack.url}/api/family/${kidId}/thats-me`, { method: 'POST', headers: auth });
  const moved = await fetch(`${stack.url}/api/family/me`, { headers: auth }).then(r => r.json());
  const fam1 = await fetch(`${stack.url}/api/family`, { headers: auth }).then(r => r.json());
  const stillOnOld = fam1.find(m => m.id === meId)?.user_id;
  const okOnlyOne = moved?.member_id === kidId && stillOnOld == null;
  console.log('[smoke] only ONE member may be me →', okOnlyOne ? 'OK (moved, old one cleared)' : `BROKEN (me=${moved?.member_id}, old=${stillOnOld})`);
  await fetch(`${stack.url}/api/family/${meId}/thats-me`, { method: 'POST', headers: auth });

  // Joint account: one account, two owners.
  const kontoId = (await fetch(`${stack.url}/api/admin/konten`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Smoke Gemeinschaftskonto', is_shared: false, account_type: 'giro' }),
  }).then(r => r.json())).id;
  await fetch(`${stack.url}/api/family/konto/${kontoId}/owners`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_ids: [meId, kidId] }),
  });
  const fam2 = await fetch(`${stack.url}/api/family`, { headers: auth }).then(r => r.json());
  const owners = fam2.filter(m => (m.konto_ids ?? []).includes(kontoId)).map(m => m.name).sort();
  const okJoint = owners.length === 2;
  console.log('[smoke] joint account has n owners →', okJoint ? `OK (${owners.join(', ')})` : `GOT ${JSON.stringify(owners)}`);

  // Leaving the household must ARCHIVE (the member owns something), not delete.
  const del = await fetch(`${stack.url}/api/family/${kidId}`, { method: 'DELETE', headers: auth }).then(r => r.json());
  const famActive = await fetch(`${stack.url}/api/family`, { headers: auth }).then(r => r.json());
  const famAll = await fetch(`${stack.url}/api/family?archived=1`, { headers: auth }).then(r => r.json());
  const okArchive = del?.archived === true
    && !famActive.some(m => m.id === kidId)
    && famAll.some(m => m.id === kidId && (m.konto_ids ?? []).includes(kontoId));
  console.log('[smoke] leaving archives, keeps ownership →', okArchive ? 'OK' : `BROKEN (${JSON.stringify(del)})`);

  // ── passkeys need a DOMAIN as the relying-party id ──────────────────────────────────────
  // An IP literal is not a valid RP ID, so a base URL of http://127.0.0.1:<port> made the browser
  // refuse every "add a passkey" attempt in the desktop app — with no server-side error to find.
  const rpOpts = await fetch(`${stack.url}/api/auth/passkey/register/options`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
  }).then(r => r.json()).catch(() => ({}));
  const rpID = rpOpts?.options?.rp?.id;
  const okRpID = !!rpID && !/^\d+\.\d+\.\d+\.\d+$/.test(rpID);
  console.log('[smoke] passkey relying-party id →', okRpID ? `OK (${rpID})` : `INVALID: ${rpID}`);

  // ── one provider for everything, vision only where it is needed ────────────────────────
  // The wizard's promise: pick Ollama once and EVERY task runs on it, with only the picture-reading
  // one on a vision model. It was broken twice over — the step needed a second Save click nobody
  // knew about, and the model review only ever covered five of the eleven tasks — so an instance
  // with no API key at all sat there with half its tasks pointing at Anthropic.
  const quick = await fetch(`${stack.url}/api/onboarding/ai-quickset`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', url: 'http://127.0.0.1:11434', ocr_model: 'qwen2.5vl:7b', ki_model: 'qwen2.5:14b' }),
  });
  const cfgAfter = await fetch(`${stack.url}/api/config`, { headers: auth }).then(r => r.json());
  const providerKeys = Object.keys(cfgAfter).filter(k => /^ai\..+\.provider$/.test(k));
  const strays = providerKeys.filter(k => cfgAfter[k] !== 'ollama');
  const okOneProvider = quick.status === 200 && providerKeys.length >= 11 && strays.length === 0;
  console.log(`[smoke] one provider for all ${providerKeys.length} tasks →`, okOneProvider ? 'OK' : `STRAYS: ${strays.join(', ')}`);
  const okVisionSplit = cfgAfter['ai.ocr.model'] === 'qwen2.5vl:7b' && cfgAfter['ai.recategorize.model'] === 'qwen2.5:14b';
  console.log('[smoke] vision model only for OCR →', okVisionSplit ? 'OK' : `ocr=${cfgAfter['ai.ocr.model']} recat=${cfgAfter['ai.recategorize.model']}`);

  // ── locked-out recovery ────────────────────────────────────────────────────────────────
  // The shell shows a one-time code in an OS dialog; here we stand in for the shell by writing the
  // file it would write, and prove the backend half: wrong code refused, right code sets the
  // password once and burns itself.
  await fetch(`${stack.url}/api/desktop/recover`, { method: 'POST' });
  const okRecoverMarker = existsSync(path.join(stack.desktopDir, 'desktop' === 'desktop' ? 'recover-request' : ''));
  console.log('[smoke] recovery request →', okRecoverMarker ? 'OK (shell would show the dialog)' : 'MARKER MISSING');

  const recoverFile = path.join(stack.desktopDir, 'recover.json');
  writeFileSync(recoverFile, JSON.stringify({ code: 'ABCD-EFGH', expires: new Date(Date.now() + 600000).toISOString() }));
  const post = (body) => fetch(`${stack.url}/api/desktop/recover/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const wrong = await post({ code: 'ZZZZ-ZZZZ', username: 'smoke', password: 'brand-new-pass' });
  console.log('[smoke] recovery wrong code →', wrong.status, wrong.status === 403 ? 'OK (refused)' : 'UNEXPECTED');

  const right = await post({ code: 'abcd-efgh', username: 'smoke', password: 'brand-new-pass' });
  const okRecovered = right.status === 200 && !!(await right.clone().json()).token;
  console.log('[smoke] recovery right code →', right.status, okRecovered ? 'OK (token issued)' : 'UNEXPECTED');
  const okBurned = !existsSync(recoverFile);
  console.log('[smoke] code burned after use →', okBurned ? 'OK' : 'STILL ON DISK');

  const relogin = await fetch(`${stack.url}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'smoke', password: 'brand-new-pass' }),
  });
  console.log('[smoke] login with the new password →', relogin.status, relogin.status === 200 ? 'OK' : 'FAILED');

  // Informational: is the compiled tunnel sidecar in place? (Absent → the app runs local-only.)
  console.log('[smoke] tunnel sidecar →', sidecarPath({ resourcesPath: null, devRoot: path.resolve(__dirname, '..') }) ? 'bundled' : 'not built (local-only)');

  const pass = okSecrets && version?.node && okPasskey && gate.status === 401 && okSpa
    && okDesktopFlag && anon.status === 401 && okStatus && okMarker
    && okRecoverMarker && wrong.status === 403 && okRecovered && okBurned && relogin.status === 200
    && okOneProvider && okVisionSplit && okRpID
    && me?.member_id === meId && okOnlyOne && okJoint && okArchive;
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
