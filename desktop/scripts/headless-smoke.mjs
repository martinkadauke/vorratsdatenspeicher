// Headless proof that the EXISTING backend runs against a BUNDLED Postgres (embedded-postgres,
// no Docker, no external server) — the make-or-break for the Electron direction. This runs the
// same boot.mjs the Electron shell uses, but forks the backend under plain Node instead of
// Electron's utilityProcess, so it works in CI / a terminal with no display.
//
// Usage: node scripts/headless-smoke.mjs [dataDir]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

/** POST a redemption; returns the parsed body, or the status when `statusOnly`. */
async function redeem2(base, token, body, statusOnly = false) {
  const r = await fetch(`${base}/api/invite/${token}/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return statusOnly ? r.status : r.json().catch(() => ({}));
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
  // ⚠️ A STUB search, not the real bundle. The desktop build ships SearXNG and hands the backend
  // its address in SEARXNG_URL; what can silently break is that HANDOVER — a renamed variable, a
  // resolver that still reads app_config first — and that is what this proves, in milliseconds and
  // without a scraper. Booting the real one would take half a minute and make the test depend on
  // Google's mood. boot() spreads process.env, so setting it here reaches the backend.
  const searchStub = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Stub-Treffer', content: 'x', url: 'https://example.org/x' }] }));
  });
  await new Promise(r => searchStub.listen(0, '127.0.0.1', r));
  searchStub.unref();          // ⚠️ or the script never exits: a listening server keeps the loop alive
  process.env.SEARXNG_URL = `http://127.0.0.1:${searchStub.address().port}`;

  // tunnel:false so the test never starts a real Funnel on a machine that happens to run Tailscale;
  // searxng:false for the same reason — this run must not spawn a Python web app.
  stack = await boot({ dataDir, backendEntry, tunnel: false, searxng: false });
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

  // `reset` is the way out of a stale sign-in link. It travels the same file bridge, so the whole
  // failure mode is "the action silently falls back to start" — which looks like nothing happening
  // and is invisible to tsc. An unknown action MUST still fall back, hence both halves.
  rmSync(marker, { force: true });
  await fetch(`${stack.url}/api/desktop/tunnel`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset' }),
  });
  const okReset = existsSync(marker) && readFileSync(marker, 'utf8').trim() === 'reset';
  rmSync(marker, { force: true });
  await fetch(`${stack.url}/api/desktop/tunnel`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'wipe-everything' }),
  });
  const okClosedSet = existsSync(marker) && readFileSync(marker, 'utf8').trim() === 'start';
  console.log('[smoke] fresh-link request →', okReset ? 'OK (reset reaches the shell)' : 'RESET LOST',
              '| unknown action →', okClosedSet ? 'OK (falls back to start)' : 'CLOSED SET LEAKS');

  // ── the bundled web search reaches the backend ─────────────────────────────────────────
  // Health goes through the same resolver as every real query, so a green answer here means the
  // address the app WOULD search on is the one it was handed.
  const health = await fetch(`${stack.url}/api/searxng/health`, { headers: auth }).then(r => r.json()).catch(() => ({}));
  const okSearch = health?.ok === true;
  console.log('[smoke] bundled search reaches the backend →',
    okSearch ? 'OK (env fact wins over config)' : `HANDOVER BROKEN (${JSON.stringify(health)})`);

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

  // ── inviting a household member ─────────────────────────────────────────────────────────
  // The invited person creates their OWN account: the admin never learns their e-mail and never
  // picks their password. Two factors on two channels — long token in the link, 4 digits spoken.
  const invMemberId = await mk('SmokeLena');
  const inv = await fetch(`${stack.url}/api/invites`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_id: invMemberId, make_admin: false }),
  }).then(r => r.json());
  const okInvite = !!inv?.token && /^\d{4}$/.test(inv?.code ?? '');
  console.log('[smoke] invite created →', okInvite ? `OK (code ${inv.code})` : JSON.stringify(inv));

  // The public link must greet by name but NEVER leak the second factor.
  const peek = await fetch(`${stack.url}/api/invite/${inv.token}`).then(r => r.json());
  const okPeek = peek?.valid === true && peek?.member === 'SmokeLena' && !('code' in peek);
  console.log('[smoke] link reveals the name, not the code →', okPeek ? 'OK' : JSON.stringify(peek));

  // Wrong codes must run out. Four digits are only safe because this counter is real and in the DB.
  const redeem = (body) => fetch(`${stack.url}/api/invite/${inv.token}/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const wrongCode = String((Number(inv.code) + 1) % 10000).padStart(4, '0');
  let lastWrong;
  for (let i = 0; i < 5; i++) lastWrong = await redeem({ code: wrongCode, username: 'lena', password: 'lena-pass-1234' });
  const locked = await redeem({ code: inv.code, username: 'lena', password: 'lena-pass-1234' });
  const okLocked = lastWrong.status === 403 && locked.status === 403;
  console.log('[smoke] five wrong codes kill the invite →', okLocked ? 'OK (even the right code is refused after)' : `w=${lastWrong.status} right=${locked.status}`);

  // A fresh invite, redeemed properly: the member gains a login, nothing else changes.
  const inv2 = await fetch(`${stack.url}/api/invites`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ member_id: invMemberId }),
  }).then(r => r.json());
  const good = await redeem2(stack.url, inv2.token, { code: inv2.code, username: 'lena', password: 'lena-pass-1234' });
  const famInv = await fetch(`${stack.url}/api/family`, { headers: auth }).then(r => r.json());
  const lena = famInv.find(m => m.id === invMemberId);
  const okRedeem = !!good?.token && lena?.user_id != null;
  console.log('[smoke] invited person owns the member →', okRedeem ? 'OK' : `token=${!!good?.token} user_id=${lena?.user_id}`);

  // And it is single-use.
  const again = await redeem2(stack.url, inv2.token, { code: inv2.code, username: 'lena2', password: 'lena-pass-1234' }, true);
  console.log('[smoke] invite is single-use →', again === 404 ? 'OK' : `status ${again}`);

  // ── passkeys need a DOMAIN as the relying-party id ──────────────────────────────────────
  // An IP literal is not a valid RP ID, so a base URL of http://127.0.0.1:<port> made the browser
  // refuse every "add a passkey" attempt in the desktop app — with no server-side error to find.
  const rpOpts = await fetch(`${stack.url}/api/auth/passkey/register/options`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
  }).then(r => r.json()).catch(() => ({}));
  const rpID = rpOpts?.options?.rp?.id;
  const okRpID = !!rpID && !/^\d+\.\d+\.\d+\.\d+$/.test(rpID);
  console.log('[smoke] passkey relying-party id →', okRpID ? `OK (${rpID})` : `INVALID: ${rpID}`);

  // ⚠️ The RP id must follow the PAGE, not a global base URL. On the desktop the window runs on
  // localhost while the tunnel address is the one we put in e-mails — deriving from the latter
  // made the browser refuse every registration, with nothing on the server to see. Same instance,
  // two origins, two answers.
  const rpFor = async (origin) => (await fetch(`${stack.url}/api/auth/passkey/register/options`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: origin }, body: '{}',
  }).then(r => r.json()).catch(() => ({})))?.options?.rp?.id;
  // Three cases, because the rule has three halves and only one of them was ever tested:
  //   loopback      → itself   (the desktop window, plain HTTP but a secure context)
  //   any HTTPS host→ itself   (EVERY Docker self-host behind a reverse proxy — this was broken:
  //                             with app.base_url pointing elsewhere the RP ID fell back to that
  //                             host, an IP in the field, which browsers reject outright)
  //   plain HTTP    → NOT itself (an insecure stranger may not choose what we mint credentials for)
  const rpLocal = await rpFor(stack.url);
  const rpProxied = await rpFor('https://vds.example.org');
  const rpInsecure = await rpFor('http://stranger.example');
  const okRpFollowsOrigin = rpLocal === 'localhost'
    && rpProxied === 'vds.example.org'
    && rpInsecure !== 'stranger.example';
  console.log('[smoke] rp id follows the page origin →',
    okRpFollowsOrigin ? `OK (loopback→${rpLocal}, https→${rpProxied}, plain http→${rpInsecure})`
                      : `WRONG (${rpLocal} / ${rpProxied} / ${rpInsecure})`);

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
    && okDesktopFlag && anon.status === 401 && okStatus && okMarker && okReset && okClosedSet && okSearch
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
