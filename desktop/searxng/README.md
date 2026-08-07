# Bundling SearXNG into the desktop app — handover

**Status: researched and de-risked, NOT wired up.** Everything in this directory works; what is
missing is a Python runtime and the CI/boot plumbing. Written so this can be picked up cold.

## Why

VDS uses web search for shop leaflets, offers, product pictures and the model-capability lookups.
Docker self-hosters point us at their own SearXNG (the wizard asks). A desktop user installed one
executable and has no idea what SearXNG is — asking them for its address is asking about plumbing
they never installed. Martin's call (2026-08-07), after being offered a cheaper alternative
(searching from the Node backend directly, no extra process): **really bundle it.**

The wizard's web-search step is already hidden on the desktop build (`buildInfo?.desktop` filter in
`Onboarding.tsx`), so today a desktop instance simply has no web search. That is the gap this
closes.

## What is already proven (measured, not assumed)

| | |
|---|---|
| Source | SearXNG is **not on PyPI**. It comes from the repo. |
| Fetching | ⚠️ **Never `git clone` on Windows.** Four files carry a colon in their name (`utils/templates/etc/nginx/default.apps-available/searxng.conf:socket` + 3 siblings). A colon is illegal in an NTFS path, so the checkout aborts — on the windows-latest runner too. Use the codeload **tarball** and extract only `searx/` + `requirements.txt`. |
| Dependencies | `pip install --target lib -r requirements.txt` → **78 MB**, all prebuilt wheels (lxml, msgspec, valkey…), **no compiler needed**. A venv is wrong here: it bakes absolute paths and breaks when the app is installed elsewhere. |
| Windows | ⚠️ **Stock SearXNG cannot start on Windows.** `searx/valkeydb.py` does `import pwd` (Unix-only) unconditionally, reached via `webapp → limiter → valkeydb`. Upstream supports Linux only and never tests Windows. Fixed by `pwd.py` in this directory, shipped into `lib/` — we do **not** fork SearXNG, so updates stay a tarball swap. |
| It works | With the shim: `GET /search?q=rewe+prospekt&format=json` → **HTTP 200 with real results**, on Windows, no Docker. |
| Noise | Individual engines failing at startup (brave 429, startpage captcha, wikidata 403) is **normal** — SearXNG aggregates and returns what answered. Do not chase these. |

## What is NOT proven yet

**The Python runtime.** The probe ran against the developer machine's own Python; a user's machine
has none. A relocatable runtime must ship alongside — use
[python-build-standalone](https://github.com/astral-sh/python-build-standalone) (releases carry
`cpython-3.12.x+<date>-x86_64-pc-windows-msvc-install_only.tar.gz` and an
`aarch64-apple-darwin` twin). Pick the version SearXNG's `requirements.txt` supports; 3.14 worked in
the probe but pin something conservative.

Expect roughly **+70–90 MB per installer** (runtime + 78 MB deps + ~30 MB source, compressed).

## Remaining work

1. **Runtime** — extend `build.sh` to fetch python-build-standalone for the runner's OS into
   `<out>/python/`, and verify `<out>/python/bin/python3 -m searx.webapp` starts.
2. **CI** — a step in the `desktop` job of `.github/workflows/release.yml`, right beside the tsnet
   sidecar step (same shape: build per OS into a gitignored `bin/`).
3. **Packaging** — an `extraResources` entry in `electron-builder.yml`: `from: searxng/bin` →
   `to: searxng`. Keep the committed empty `bin/` + `.gitkeep` trick; electron-builder aborts on a
   missing source.
4. **Boot** — in `boot.mjs`, beside the Postgres start: pick a free port, write `settings.yml` into
   the data dir with a **per-install** `secret_key` (reuse `resolveSecrets`, never ship a constant)
   and that port, then spawn the runtime with
   `PYTHONPATH=<res>/searxng/lib:<res>/searxng/searx-root` and `SEARXNG_SETTINGS_PATH`.
   Stop it in `stack.stop()`. It is slow to start (~5 s) — do not block the window on it.
5. **Config** — set `searxng.url` to `http://127.0.0.1:<port>` on every desktop boot. It is a FACT,
   not a setting, exactly like `app.base_url` on the desktop build: see `effectiveBaseUrl()` in
   `backend/src/config.ts` and mirror that pattern rather than writing the value into `app_config`
   once (the port can change).
6. **Verify** — extend `desktop/scripts/headless-smoke.mjs`: sidecar answers `/search?format=json`,
   and `searxngHealth()` reports ok.

## Files here

- `build.sh` — steps 1–3 of the assembly, minus the runtime. Run: `bash build.sh bin`
- `pwd.py` — the Windows shim. Read its docstring before touching it.
- `settings.yml` — the exact configuration that was verified to work; `__SECRET_KEY__` and
  `__PORT__` are placeholders the shell fills in.
