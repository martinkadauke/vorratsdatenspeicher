<div align="center">

# 🗄️ Vorratsdatenspeicher

**The mobile-first, self-hosted household app.**
Snap a receipt at the checkout — AI reads every line item, sorts it, and shows you where your money goes.
All on **your** server. Not in someone's cloud.

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Self-hosted](https://img.shields.io/badge/self--hosted-one%20container-059669)
![PWA](https://img.shields.io/badge/PWA-installable-059669)

**[Live demo](https://demo.vorratsdatenspeicher.com)** · **[Website](https://vorratsdatenspeicher.com)** · `ghcr.io/martinkadauke/vorratsdatenspeicher`

</div>

---

The name is a joke — it's the German term for state-mandated "data retention." The twist: **you** are the only one storing your data. No account with us, no tracking, no cloud. VDS runs as a single Docker container on your server, NAS, or Raspberry Pi.

It started as a receipt scanner for one family and grew into a whole household finance & pantry hub: multi-user, shared and private accounts, per-person spend split, German & English UI.

## What it does

- 📸 **Receipts by AI vision** — photograph a supermarket till receipt (or import a PDF / e-mail invoice) and the AI reads the store, date, total, and *every* line item — all editable. No typing.
- 🗂️ **Auto-categorised** — each item lands in the right category (fruit → fruit, diesel → fuel). Rename a product once and it cascades to every past purchase.
- 📊 **Ask your stats** — natural-language questions ("How much on fuel in 2026?"). A hallucination-proof agent turns the question into a dashboard spec; the **backend** computes every number against a read-only metrics layer. Traceable, never guessed.
- 🛒 **Shopping lists** — low-stock suggestions from a consumption model, sorted per store, shared with the whole household by e-mail/push, with current offers folded in.
- 🥫 **Pantry & offers** — a live estimate of what's at home and what's running low, plus leaflet deals from your local stores.
- 👨‍👩‍👧‍👦 **Household & family** — shared / personal / cash accounts, spending per person, privacy-scoped receipts. Multi-household ready.
- 💶 **Finances** — fixed costs, income, budgets and bank-statement matching — the household's money in one place.
- 🔔 **Notifications** — branded transactional e-mail + Web Push (VAPID). Installs as a PWA with its own home-screen icon.

## Quick start

You need [Docker](https://docs.docker.com/get-docker/). Save this as `docker-compose.yml`, **change the two secrets**, and run `docker compose up -d`:

```yaml
services:
  vds:
    image: ghcr.io/martinkadauke/vorratsdatenspeicher:stable
    ports: ["8766:80"]                                 # open http://localhost:8766
    environment:
      DATABASE_URL: postgres://vds:vds@db:5432/vds
      JWT_SECRET: change-me-to-something-secret        # ← change
      INTERNAL_SECRET: change-me-to-something-else     # ← change
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
  searxng:                               # web search for the AI — set http://searxng:8080 in VDS setup
    image: searxng/searxng:latest
    configs: [{ source: searxng, target: /etc/searxng/settings.yml }]
    restart: unless-stopped
configs:
  searxng:
    content: |
      use_default_settings: true
      server: { secret_key: "change-me-searxng-secret", limiter: false }
      search: { formats: [html, json] }
volumes:
  vds-receipts: {}
  vds-db: {}
```
> SearXNG ships in the stack so the AI's web-search (churn stage 2, store enrichment) works out of the box — it's [AGPL-3.0](https://github.com/searxng/searxng), run unmodified. It's optional: remove the `searxng` service if you don't want it. Point VDS at it in **Setup → SearXNG** with `http://searxng:8080`. Needs Docker Compose ≥ 2.23 for the inline `configs`.

Then open **http://localhost:8766** — the first-run setup wizard walks you through the rest (AI provider, categories, household). First login is `admin` / `vorrat-start-2026` (override with `ADMIN_PASSWORD`, reset with `ADMIN_RESET=true`).

> **Install it as an app (PWA):** iPhone → Safari → Share → *Add to Home Screen*. Android → Chrome → *Install app*. PWA install needs HTTPS in the cloud (`http://localhost` is fine locally) — put a reverse proxy like Caddy in front.

Prefer to build from source instead of pulling the image? Replace the `image:` line with `build: .` and run `docker compose up -d --build`.

## Bring your own AI

VDS uses AI to read receipts, categorise, and answer stats questions. You pick a provider **per task** and mix them freely:

| Provider | Good for | Cost |
|---|---|---|
| **Anthropic** (Claude) | Reading receipt photos (vision), reasoning | ~1–2 ct / receipt |
| **DeepSeek** | Cheap text categorisation | fractions of a cent |
| **Ollama** | Fully local, zero cloud | free (your GPU) |

Drop your API key(s) in during setup — or run categorisation entirely on a local Ollama and keep even the AI on-prem.

## How it's built

| Layer | Tech |
|---|---|
| Frontend | React 18 + Vite + TypeScript, Tailwind, React Query, i18next (DE/EN), a PWA |
| Backend | Fastify 5 + TypeScript, `postgres.js` (plain SQL, no ORM), JWT auth |
| AI | Pluggable — Anthropic / DeepSeek / Ollama, per-task model choice |
| Data | PostgreSQL. SQL migrations run automatically on boot |
| Infra | **One** Docker image serves the SPA + API + receipt files |

Most configuration lives in the database (`app_config`) and is editable at runtime in **Admin** — most settings change with no redeploy. `GET /api/version` returns the build SHA for deploy verification.

## Development

```bash
# backend  (http://localhost:8080)
cd backend && npm install && npm run dev
# frontend (http://localhost:5173, proxies /api → backend)
cd frontend && npm install && npm run dev
```

A local Postgres is all you need; migrations apply on the backend's first boot.

## License

[GNU AGPL-3.0](LICENSE). Self-host it, modify it, share it — if you run a modified version as a network service, you share your changes.
