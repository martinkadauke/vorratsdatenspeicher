# Vorratsdatenspeicher

Self-hosted household pantry & spending tracker. Single Docker container: React PWA + Fastify API. Receipt ingestion stays in n8n (Einkaufszettelpuppe → Telegram → OCR → Postgres); everything else lives here.

## Features

- **Belege** — past store runs with receipt photo + parsed line items; every field editable, category changes can cascade to all purchases of the same canonical name
- **Statistik** — monthly spending per category (3-level drilldown), editable per-month goals, MTD spend + linear EOM projection, per-family-member filter
- **Vorrat / Einkaufsliste** — pantry estimates and low-stock shopping suggestions
- **Namen** — canonical-name management with cascading rename
- **Verifikations-Queue** — approve/edit/reject AI-proposed canonical names
- **Churner** — nightly in-app job (Ollama + SearXNG web grounding) that cleans up weak canonical names; all results surface in the notification bell, never auto-writes below the confidence threshold
- **Familie** — tag who consumes what ("nur Martin isst Thunfisch"), split spending accordingly
- **Users** — JWT auth, admin panel, dark mode, German/English UI

## Stack

| | |
|---|---|
| Frontend | React 18, Vite, TypeScript, Tailwind, TanStack Query, react-i18next, Recharts |
| Backend | Node 20, Fastify 5, postgres.js, node-cron, JWT (HS256), bcrypt |
| Infra | Single Docker image; Postgres + Ollama + SearXNG run elsewhere on the LAN |

## Development

```bash
# backend (terminal 1)
cd backend
npm install
DATABASE_URL=postgres://user:pw@192.168.1.238:5432/db JWT_SECRET=dev INTERNAL_SECRET=dev npm run dev

# frontend (terminal 2) — proxies /api to localhost:3000
cd frontend
npm install
npm run dev
```

Migrations in `backend/migrations/*.sql` run automatically at backend startup (tracked in `schema_migrations`).

## Deployment (Unraid)

```bash
docker build -t vorratsdatenspeicher .
docker run -d \
  --name vorratsdatenspeicher \
  --restart unless-stopped \
  -p 8766:80 \
  -e DATABASE_URL='postgres://USER:PW@192.168.1.238:5432/DB' \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e INTERNAL_SECRET="$(openssl rand -hex 16)" \
  -v /mnt/user/Aufnahmen/receipts:/app/public/receipts:ro \
  vorratsdatenspeicher
```

Then point your reverse proxy (NPM) at port 8766. No extra `/api` routing needed — the container serves SPA, API and `/receipts/*` itself.

**First login:** user `martin`, password `vorrat-start-2026` — change it immediately in Profil.

## n8n integration

At the end of the Einkaufszettelpuppe workflow add one HTTP Request node per new artikel:

```
POST http://<container-host>:8766/api/internal/recategorize-one
Header: X-Internal-Secret: <INTERNAL_SECRET>
Body: { "artikel_id": <id> }
```

This assigns a category to new line items the moment a receipt arrives.

## Admin settings (in-app)

Ollama URL + model, churner enable/cron/confidence threshold, SearXNG URL, default language — all editable under **Admin → Einstellungen**, stored in the `app_config` table.
