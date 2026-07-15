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
| [SearXNG](https://github.com/searxng/searxng) | metasearch engine (optional web-search for the churner + store enrichment; shipped as the official image, **unmodified**) | **AGPL-3.0-or-later** |
| [Ollama](https://ollama.com) | local model server (optional; you run it, we only call its API) | MIT |
| [Caddy](https://caddyserver.com) | reverse proxy (demo only) | Apache-2.0 |

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
