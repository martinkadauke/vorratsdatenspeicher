# Vorratsdatenspeicher — Desktop (Electron)

Ship VDS as a **download-and-run desktop app** (`.dmg` / `.exe` / `.AppImage`) so a
non-technical user skips Docker, servers, DynDNS and reverse proxies entirely. This is the
**same codebase** as the Docker self-host image — the desktop layer is only host/DB glue.

## How it works — a "mini docker-compose" without Docker

`boot.mjs` is the orchestrator (what `docker-compose.yml` does today, minus Docker):

1. Start a **bundled Postgres** (`embedded-postgres` → a real PG binary, no external server).
2. Fork the **existing backend** (`../backend/dist/index.js`) pointed at it — byte-for-byte the
   same code the Docker image runs; only `DATABASE_URL` / `MIGRATIONS_DIR` / `PUBLIC_DIR` differ.
3. The Electron main process (`main.mjs`) opens a window at `http://127.0.0.1:8899`.

`searxng` would be a second sidecar started here the same way — **deferred** for this boot PoC.

## Status — boot PoC PROVEN (headless)

`npm run smoke` runs `boot.mjs` under plain Node (no display needed) and asserts:

- bundled Postgres 17 boots (no Docker) and the backend runs **all migrations** against it;
- `/api/version` responds (fresh single-household install, `needs_setup:true`);
- passkeys work (`login/options` issues a challenge; `register/options` is 401 without a token);
- `GET /` serves the built SPA (so the window shows the real app, not just the API).

The Electron **window** itself (`npm start`) needs a desktop session — run it on a real machine.

## Run it

```bash
# from repo root: build the app the desktop wraps
(cd backend && npm ci && npm run build)
(cd frontend && npm ci && npm run build)

cd desktop
npm install              # pulls Electron + the embedded Postgres binary for your OS
npm run smoke            # headless proof (no window)
npm start                # opens the real Electron window
```

## Packaging (recipe written, build on each OS / in CI)

`electron-builder.yml` bundles the existing `backend/dist` + `backend/migrations` +
`frontend/dist` as `extraResources` (matching `main.mjs`'s packaged paths), unpacks the native
Postgres binary out of the asar, and targets **NSIS** (Win) / **DMG** (Mac) / **AppImage** (Linux),
**unsigned** (free path). Installers must be built on their own OS (or a CI matrix):

```bash
(cd ../backend && npm ci --omit=dev)   # prune to prod deps so the bundle isn't huge
cd desktop && npm install
npm run pack     # electron-builder --dir → out/<platform>-unpacked (fast assemble check)
npm run dist     # full installer
```

⚠️ Not built/verified in the dev sandbox (needs Electron + a real per-OS toolchain). The
known-fiddly bit is the **embedded-postgres native binary under asarUnpack** — confirm `initdb`
runs from the unpacked path on a real `npm run pack` before trusting the recipe.

## Known gotchas / decisions

- **UTF8 is mandatory.** On Windows `initdb` defaults to the OS locale (WIN1252), which can't
  represent umlauts / emoji / box-drawing chars in VDS's SQL+data → `boot.mjs` forces
  `--encoding=UTF8 --locale=C`.
- **`embedded-postgres` ships beta-only** (latest `17.10.0-beta.17`). Fine for the PoC; for the
  shipped build evaluate **PGlite + `pglite-socket`** (mature, in-process) as the alternative.
- Backend gained two embedder-friendly env overrides (harmless in Docker): `MIGRATIONS_DIR`
  and `PUBLIC_DIR`, because a packaged app's `cwd` is unpredictable.
- Secrets (`JWT_SECRET` / `INTERNAL_SECRET`) are random-per-boot here; the shipped build must
  generate them **once** and persist per install (in `userData`) so logins survive restarts.

## Next (not built)

`electron-updater` auto-update (from the same GitHub Release assets), the **searxng sidecar**,
wiring the live **Tailscale Funnel** host into the passkey RP-ID / `app.base_url`, the
**QR-to-connect + PWA install** screen, and **invite-by-link**. First real-machine checks:
`npm start` (see the window) and a Tailscale login (prove the Funnel). See the
`project-vds-electron-passkeys` memory.
