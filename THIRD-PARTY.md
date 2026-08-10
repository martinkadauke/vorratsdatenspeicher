# Third-party components & licenses

Vorratsdatenspeicher (VDS) itself is licensed **AGPL-3.0-only** (see `LICENSE`).
It builds on, ships alongside, or talks to the third-party components below. This file is a
human-readable overview; the authoritative license text for each npm package ships inside the
Docker image under `node_modules/<pkg>/LICENSE`. A machine-generated SBOM can be produced with
`npx license-checker --production` in `backend/` and `frontend/`.

## Runtime & infrastructure

| Component | Role | License |
|---|---|---|
| [Node.js](https://nodejs.org) | JS runtime | MIT |
| [PostgreSQL 16](https://www.postgresql.org) | database (shipped as the official `postgres:16` image, unmodified) | PostgreSQL License |
| [SearXNG](https://github.com/searxng/searxng) | metasearch engine — web search for the churner + store enrichment. **Docker:** you run the official image yourself, we only call it. **Desktop:** we ship an assembly of it (see below), which makes this the licence that binds us hardest. | **AGPL-3.0-or-later** |
| [Ollama](https://ollama.com) | local model server (optional; you run it, we only call its API) | MIT |
| [Caddy](https://caddyserver.com) | reverse proxy (demo only) | Apache-2.0 |

## Shipped inside the desktop installer

⚠️ The Docker image *calls* the services above; the desktop installer **redistributes** the
components below. That is a different legal situation, and it is why they are listed separately.

| Component | Role | License |
|---|---|---|
| [Electron](https://electronjs.org) (incl. Chromium, Node.js) | the application shell | MIT (Chromium: BSD-3-Clause + others) |
| [embedded-postgres](https://github.com/leinelissen/embedded-postgres) + PostgreSQL 17 binaries | the bundled database — no Docker needed | Apache-2.0 / PostgreSQL License |
| [SearXNG](https://github.com/searxng/searxng) | bundled web search. ⚠️ **Not** the official image: we assemble it from a pinned commit and add one file, `desktop/searxng/pwd.py`, without which it cannot start on Windows. **AGPL-3.0 obliges us to offer that assembly's source** — it is in this repository under `desktop/searxng/` (build script, shim, settings, pinned commit). | **AGPL-3.0-or-later** |
| [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (CPython 3.12) | the interpreter SearXNG runs on | Python Software Foundation License (CPython) / MPL-2.0 (build tooling) |
| SearXNG's Python dependencies (flask, httpx, lxml, msgspec, babel …) | installed into the bundle by `desktop/searxng/build.sh` | each its own — predominantly BSD/MIT/Apache-2.0; `requirements.txt` in the bundle names every one |
| [tailscale.com/tsnet](https://tailscale.com) | the embedded Tailscale node behind "connect your phone" | BSD-3-Clause |
| [electron-builder](https://www.electron.build) / [@electron/osx-sign](https://github.com/electron/osx-sign) | packaging and the ad-hoc macOS signature (build-time) | MIT |

## Data sources

| Source | Use | Terms |
|---|---|---|
| **OpenStreetMap** via [Nominatim](https://nominatim.org) + [Overpass API](https://overpass-api.de) | geocoding, store discovery, opening hours | Map data **© OpenStreetMap contributors**, available under the **Open Database License (ODbL 1.0)**. Attribution is shown in-app and on the website. |
| [Marktguru](https://www.marktguru.de) | supermarket offers (public endpoints) | © Marktguru; used under their terms of service. Not redistributed. |

## AI providers (services — used via API, not redistributed)

Anthropic (Claude), OpenAI (GPT), DeepSeek — proprietary APIs governed by each provider's terms.
**Local models** pulled through Ollama (e.g. Qwen2.5 & Mistral-Small = Apache-2.0; Google Gemma =
Gemma Terms of Use; Meta Llama = Llama Community License) carry their **own** licenses — the
self-hoster is responsible for complying with the license of any model they choose to run.

## Backend npm dependencies

| Package | License |
|---|---|
| fastify, @fastify/static | MIT |
| postgres (postgres.js) | Unlicense |
| bcryptjs, jsonwebtoken | MIT |
| node-cron | ISC |
| nodemailer, mailparser, imapflow | MIT |
| jimp | MIT |
| web-push | MPL-2.0 |

## Frontend npm dependencies

| Package | License |
|---|---|
| react, react-dom, react-router-dom | MIT |
| @tanstack/react-query | MIT |
| @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities | MIT |
| i18next, react-i18next | MIT |
| lucide-react | ISC |
| recharts | MIT |
| pdfjs-dist | Apache-2.0 |
| react-arborist, react-zoom-pan-pinch | MIT |
| clsx, tailwind-merge | MIT |
| tailwindcss, vite, @vitejs/plugin-react, postcss, autoprefixer (build) | MIT |

*This overview is provided in good faith and is not legal advice. For commercial distribution,
obtain your own review. If you spot an inaccuracy, please open an issue.*
