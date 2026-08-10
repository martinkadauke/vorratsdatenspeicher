<div align="center">

<img src="frontend/public/icon-192.png" alt="" width="96" height="96">

# Vorratsdatenspeicher

**The household app that reads your receipts.**
Photograph a till receipt — AI reads every line item, sorts it, and shows you where your money goes.
On **your** computer. Not in someone's cloud.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Desktop app](https://img.shields.io/badge/desktop-Windows%20%7C%20macOS-059669)
![Self-hosted](https://img.shields.io/badge/self--hosted-one%20container-059669)
![PWA](https://img.shields.io/badge/PWA-installable-059669)

**[Download](https://github.com/martinkadauke/vorratsdatenspeicher/releases/latest)** · **[Install guide](https://vorratsdatenspeicher.com/guide/)** · **[Live demo](https://demo.vorratsdatenspeicher.com)** · **[Website](https://vorratsdatenspeicher.com)**

</div>

---

The name is a joke — it's the German term for state-mandated "data retention". The twist: **you** are the only one storing anything. No account with us, no tracking, no cloud.

It started as a receipt scanner for one family and grew into a household finance and pantry hub: multiple people, shared and private accounts, spending per person, returns, bank reconciliation, German and English UI.

## Two ways to run it

|  | **Desktop app** | **Docker** |
|---|---|---|
| For | one household, one computer | a server, NAS or VPS |
| Setup | download, double-click | `docker compose up -d` |
| Database | brought along (PostgreSQL 17) | your own `postgres:16` |
| Web search | brought along (SearXNG + Python) | your own SearXNG, or none |
| Phone access | built in — a QR code, no port forwarding | your own URL / reverse proxy |
| Updates | one click in the app | `docker compose pull`, or the [updater sidecar](#one-click-updates-optional) |

Same code, same features, same data model. Pick whichever fits.

## What it does

**Receipts**
- 📸 **Read by AI vision** — photograph a till receipt, or import a PDF or e-mail invoice, and the AI reads store, date, total and *every* line item. All editable, no typing.
- 🗂️ **Auto-categorised** — each item lands in the right category. Rename a product once and it cascades through every past purchase.
- ✅ **Review queue** — ambiguous product names are grouped by the raw receipt text, so 200 receipts carrying the same cryptic line are one decision, not two hundred. The same page confirms the unit a price-per-unit should use.
- ↩️ **Returns** — refunds book as negative positions. A *partial* return splits the original line, so the pantry counts exactly what you kept. Reachable from a bank credit, a refund e-mail, or by hand.
- 📥 **Drop folder** — put invoices in a watched folder and they import themselves.

**Money**
- 💶 **Fixed costs, income, budgets** — with per-month evidence: attach the invoice, propose the matching bank entry, see "7 of 9 done".
- 🏦 **Bank import** — comdirect CSVs have a fixed parser; **any other bank is recognised once by the AI**, learned by its header fingerprint, and replayed deterministically afterwards. Preview before it commits, undo the whole import.
- 🔗 **Reconciliation** — accept or reject AI match suggestions, or turn a bank entry straight into a receipt or a fixed cost.
- 📊 **Ask in plain language** — "fuel last year?" sets the filters on the spending page. It never invents a number: the assistant only chooses category, period and accounts, and the backend computes everything after that.

**Household**
- 👨‍👩‍👧‍👦 **People and accounts** — shared, personal and cash accounts; spending per person; receipts scoped to who may see them.
- ✉️ **Invitations** — invite a household member and they create **their own** login. The link travels one way, a four-digit code another; neither alone is enough.
- 🔑 **Passkeys** — passwordless sign-in per device, alongside passwords.

**Shopping & pantry**
- 🛒 **Lists** — several of them (by shop type), a shopping mode that only clears items when you are done, a per-shop view and a price comparison.
- 🥫 **Pantry** — a live estimate of what is at home and what is running out, with the weekly consumption of any product overridable by hand.
- 🏷️ **Offers** — leaflet deals from shops near you, watchlists for individual products, shops discovered from OpenStreetMap.

**Around the edges**
- 🔔 Notifications in-app, by e-mail and Web Push · monthly reminders you can switch off per person
- 🐞 A feedback button that screenshots the page, lets you scribble on it, and mails it
- 💸 Token and cost per AI task in the admin area, so "1–2 cents a receipt" is something you can check

## Desktop app

**[Download the latest release](https://github.com/martinkadauke/vorratsdatenspeicher/releases/latest)** — `…Setup-<version>.exe` for Windows, `…Setup-<version>.dmg` for Macs with Apple Silicon. Roughly 170 MB and 235 MB, because everything is in there: the app, the database, a web-search engine with its own Python, and the phone connection.

**Windows** shows a SmartScreen prompt on first start — *More info → Run anyway*. **macOS** shows "Apple could not verify…" — approve it once under *System Settings → Privacy & Security → Open Anyway*. Both appear because no one paid for a code-signing certificate, not because anything is wrong with the file; the [install guide](https://vorratsdatenspeicher.com/guide/) has screenshots and the details.

- **Updates** — the app tells you when a new version is out and installs it on one click. Your data is untouched.
- **Your data** lives in `%APPDATA%\vorratsdatenspeicher-desktop` (Windows) or `~/Library/Application Support/vorratsdatenspeicher-desktop` (macOS), alongside a log file that says exactly what happened at startup.
- **Your phone** — "Connect your phone" starts an embedded [Tailscale](https://tailscale.com) node and shows a QR code. No Tailscale installation, no router settings, no open ports; the connection is encrypted end-to-end and terminates on your own machine. It needs a free Tailscale account, and publishing the address can take Tailscale a while — the app waits and tells you when it is ready.
- ⚠️ **Windows only:** the data path must not contain a space — the bundled `initdb` refuses one. The app says so plainly at startup rather than failing later.

## Quick start (Docker)

You need [Docker](https://docs.docker.com/get-docker/). Save this as `docker-compose.yml`, **set the two secrets** to real random strings, and run `docker compose up -d`. Generate each with `openssl rand -hex 32` — the app **refuses to start** if either is missing or guessable (one of them signs the full-backup download).

```yaml
services:
  vds:
    image: ghcr.io/martinkadauke/vorratsdatenspeicher:stable
    ports: ["8766:80"]                                 # then open http://<your-server-ip>:8766
    environment:
      DATABASE_URL: postgres://vds:vds@db:5432/vds
      JWT_SECRET: REPLACE_ME                           # ← `openssl rand -hex 32`
      INTERNAL_SECRET: REPLACE_ME                      # ← `openssl rand -hex 32` (a different one)
      # MAILBOX_ENC_KEY: REPLACE_ME                    # only if you use e-mail import — see below
    volumes: ["vds-receipts:/receipts"]
    depends_on:
      db: { condition: service_healthy }               # wait for Postgres before first boot
    restart: unless-stopped
  db:
    image: postgres:16
    environment: { POSTGRES_USER: vds, POSTGRES_PASSWORD: vds, POSTGRES_DB: vds }
    volumes: ["vds-db:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vds -d vds"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped
  searxng:                                             # optional; see the note below
    image: searxng/searxng:latest
    configs: [{ source: searxng, target: /etc/searxng/settings.yml }]
    restart: unless-stopped
configs:
  searxng:
    content: |
      use_default_settings: true
      server: { secret_key: "change-me", limiter: false }
      search: { formats: [html, json] }
volumes:
  vds-receipts: {}
  vds-db: {}
```

> **Architecture:** the published images are **linux/amd64** only — an ARM box such as a Raspberry Pi cannot pull them. Building from source on ARM is untested.

> **Web search is optional.** SearXNG gives the AI a way to look things up (resolving cryptic receipt lines, shop logos, product pictures). Without it VDS runs fine and simply skips those. Point VDS at it under **Setup → SearXNG** with `http://searxng:8080`. The inline `configs` need Docker Compose ≥ 2.23. It is [AGPL-3.0](https://github.com/searxng/searxng) and run unmodified here.

Then open **http://&lt;your-server-ip&gt;:8766** (`localhost` only if Docker runs on the machine in front of you).

**There is no default password.** A fresh install has no user at all: the first page you see asks you to create the owner account, and only that first one can be created without logging in. Prefer to seed it from the environment? Set `ADMIN_PASSWORD` (and optionally `ADMIN_USERNAME`, default `admin`) before the first boot. Locked out later? Set `ADMIN_RESET=true` and restart once — it applies only when the credentials actually change, so it is safe to leave in place.

The setup wizard then walks you through the rest: language, AI provider, categories, household, accounts, e-mail.

> **E-mail import (optional):** if you connect a mailbox, also set **`MAILBOX_ENC_KEY`** to its own `openssl rand -hex 32`. Without it, mailbox passwords are encrypted with a key derived from `JWT_SECRET` — so rotating that would make them undecryptable. A dedicated key keeps the two independent.

> **Install it as an app (PWA):** iPhone → Safari → Share → *Add to Home Screen*. Android → Chrome → *Install app*. This needs HTTPS when it is not on `localhost` — put a reverse proxy such as Caddy in front. On a phone, VDS offers this by itself on the first visit.

Prefer to build from source? Clone this repository and run `docker compose up -d --build` **inside it** with `build: .` instead of the `image:` line — the Dockerfile needs `frontend/` and `backend/` in its build context, so a folder containing only a compose file will not do.

### One-click updates (optional)

By default the update banner shows you the command to run. To update **from inside the app**, add the small `updater` sidecar below. When you click **Update now**, VDS drops a marker file; the sidecar sees it and runs `docker compose pull vds && docker compose up -d --no-deps vds`, then the page reloads onto the new version.

VDS itself stays **unprivileged** — it has no access to Docker. It only writes a marker file; the sidecar does the pull-and-restart, and only ever recreates the `vds` service, never your database.

> **Security:** the sidecar mounts the Docker socket, which is **root-equivalent on the host**. That is why this is opt-in — add it only on a host you alone control. It runs a single fixed command and takes no input from the app beyond "an update was requested".

Three small edits to your `docker-compose.yml` — **merge** each into the block that is already there.

**1.** In the **`vds`** service, add the `SELF_UPDATE` flag and the `vds-updater` volume:

```yaml
  vds:
    # …everything you already have (image, ports, depends_on, restart)…
    environment:
      # …your existing vars (DATABASE_URL, JWT_SECRET, …)…
      SELF_UPDATE: "1"                      # ← add: shows the in-app "Update now" button
    volumes:                                # ← replaces the inline volumes: [ … ] line
      - vds-receipts:/receipts
      - vds-updater:/updater                # ← add: shared marker channel with the sidecar
```

**2.** Add the **`updater`** service under `services:`:

```yaml
  updater:
    image: docker:cli                       # ships the compose plugin
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./:/project                         # the folder holding THIS docker-compose.yml
      - vds-updater:/updater
    working_dir: /project
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        rm -f /updater/request /updater/status
        proj=$$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$$(hostname)" 2>/dev/null)
        echo "updater ready — bound to compose project '$$proj', watching for update requests"
        while true; do
          if [ -f /updater/request ]; then
            rm -f /updater/request
            echo running > /updater/status
            echo "update requested — pulling + recreating vds"
            if [ -n "$$proj" ] && docker compose -p "$$proj" pull vds && docker compose -p "$$proj" up -d --no-deps vds; then
              echo ok > /updater/status
            else
              echo failed > /updater/status
            fi
          fi
          sleep 3
        done
```

**3.** Add `vds-updater: {}` to your existing top-level `volumes:` block.

Then `docker compose up -d`. The button appears in the update banner (admin only) whenever a newer release is out.

## Bring your own AI

VDS uses AI to read receipts, categorise them and interpret questions. You pick a provider **per task** and mix them freely.

| Provider | Good for | Reads receipts? | Cost |
|---|---|---|---|
| **Anthropic** (Claude) | reading receipts, reasoning | ✅ photos **and** PDFs | ~1–2 ct / receipt |
| **OpenAI** (GPT) | everything, if you already have a key | ✅ photos only | varies |
| **Ollama** | fully local, zero cloud | ✅ photos only (needs a vision model) | free (your GPU) |
| **DeepSeek** | cheap text categorisation | ❌ | fractions of a cent |

> **PDF invoices need Anthropic.** Everyone else reads photos only, and DeepSeek reads no receipts at all — with DeepSeek alone the app runs fine but scans nothing. Point the receipt task at a local Ollama vision model and your photos never leave the machine.

The setup wizard can put **all** AI tasks on one provider in a single step, so nobody has to understand the per-task table to get started.

## How it's built

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite + TypeScript, Tailwind, React Query, i18next (DE/EN), a PWA |
| Backend | Fastify 5 + TypeScript, `postgres.js` (plain SQL, no ORM), JWT auth, passkeys |
| AI | Pluggable — Anthropic / OpenAI / DeepSeek / Ollama, per-task model choice |
| Data | PostgreSQL. SQL migrations run automatically on boot |
| Docker | **One** image serves the SPA, the API and the receipt files |
| Desktop | Electron, with PostgreSQL, SearXNG (+ CPython) and a Tailscale node bundled in |

Most configuration lives in the database (`app_config`) and is editable at runtime in **Admin** — most settings change with no redeploy. `GET /api/version` returns the build SHA for deploy verification.

## Development

```bash
# backend  (http://localhost:3000)
cd backend && npm install && npm run dev
# frontend (http://localhost:5173, proxies /api → backend)
cd frontend && npm install && npm run dev
```

A local Postgres is all you need; migrations apply on the backend's first boot. For the desktop shell see [`desktop/README.md`](desktop/README.md).

## License

[GNU AGPL-3.0](LICENSE). Self-host it, modify it, share it — if you run a modified version as a network service, you share your changes. Third-party components, including everything the desktop installer ships, are listed in [THIRD-PARTY.md](THIRD-PARTY.md).
