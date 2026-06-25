# Vorratsdatenspeicher (VDS)

Self-hosted household pantry, receipts & spending tracker — and, increasingly, a whole-household finance hub. One Docker image: a React PWA + a Fastify API over Postgres. Receipts are read by AI vision OCR (supermarket till receipts **and** PDF / e-mail invoices); the rest is line-item bookkeeping, pantry tracking, offers and analytics for your household.

Built for a real family: multi-user, multiple accounts (shared / personal / cash), privacy-scoped data, German & English UI.

## Features

**Belege (receipts)**
- AI **vision OCR** (Anthropic) for till receipts and PDF/image invoices — store, date, total and every line item, all editable; category changes cascade to all purchases of the same canonical name.
- **E-mail import** — each person connects their own IMAP mailbox under *Profile*; forwarded/incoming invoices are filed as receipts automatically. Invoice-aware: skips AGB/legal-boilerplate attachments, falls back to the e-mail body, and anchors the date on the mail header.
- Manual entry & photo upload, review-progress bar, month scrubber, card-size zoom, collapsible source/account/store filters.

**Warenstamm (master data)** — one tabbed hub:
- *Artikel* — canonical products (cascading rename, base unit / Grundpreis, expected price, consumers).
- *Positionen* — every individual line item, searchable & filterable.
- *Vorrat* — live pantry estimate per tracked product from purchase history (quantity-weighted consumption rate, unit-reconciled), with **manual stock & weekly-consumption overrides** and iron-reserve batches with expiry.

**Einkaufsliste** — low-stock suggestions from the same consumption model; by-store price comparison; share with the household (e-mail and/or push).

**Angebote (offers)** — Marktguru leaflet offers for subscribed products (no API key needed); daily digest by e-mail and/or push.

**Läden · Statistik · Analytics**
- Store & chain profiles.
- Monthly spending per category (3-level drilldown), editable goals, MTD + end-of-month projection, per-family-member filter (Recharts).
- **Analytics** — "ask your data" in natural language: a hallucination-proof agent emits a dashboard spec, and the backend computes every number against a read-only metrics layer.

**Prüfung & Churner** — review queue for AI-proposed canonical names; a scheduled in-app job (configurable model + SearXNG web grounding) cleans up weak names and never auto-writes below the confidence threshold; results surface in the notification bell.

**Household** — accounts (shared / personal / cash), family members ("only Martin eats tuna") with spend split, privacy-scoped receipts.

**Notifications** — branded transactional e-mails (with logo) and **Web Push** (installable PWA, VAPID); per-type & per-channel kill-switches in Admin.

**Admin** — pluggable AI providers (Anthropic / DeepSeek / Ollama) with **per-task** model selection, bi-weekly model-review suggestions, token usage, categories, accounts, family, SMTP, notifications, household/offers.

## Stack

| | |
|---|---|
| Frontend | React + Vite + TypeScript, Tailwind, TanStack Query, react-i18next, Recharts, dnd-kit, pdf.js |
| Backend | Node 20 + Fastify 5, postgres.js (plain SQL, **no ORM**), node-cron, JWT (HS256) + bcrypt, web-push, imapflow + mailparser, nodemailer, jimp |
| AI | Anthropic vision/text OCR by default; provider abstraction (DeepSeek, Ollama) with per-task models; SearXNG for web grounding |
| Data | PostgreSQL; numbered SQL migrations applied on boot (tracked in `schema_migrations`) |
| Infra | Single Docker image serving SPA + API + `/receipts/*`; config lives in the DB (`app_config`), so most settings change with no redeploy |

## Architecture notes
- **Monorepo** (`/frontend`, `/backend`); the backend serves the built SPA statically and the API under `/api/*`.
- **Config in the database** — AI keys/models, SMTP, schedules and toggles are all editable at runtime in *Admin*; only bootstrap secrets come from env.
- **Migrations on boot**, tracked in `schema_migrations`. `GET /api/version` returns the build SHA, so a deploy can be verified end-to-end.

## Development

```bash
# backend (terminal 1)
cd backend && npm install
DATABASE_URL=postgres://user:pw@HOST:5432/db JWT_SECRET=dev INTERNAL_SECRET=dev npm run dev

# frontend (terminal 2) — proxies /api to localhost:3000
cd frontend && npm install && npm run dev
```

Migrations run automatically at backend start. Then set the **Anthropic API key** (and anything else) in *Admin* — nothing AI-related is hard-coded.

## Deployment

The image serves the SPA, API and `/receipts/*` itself — just point a reverse proxy at it, no extra `/api` routing needed.

```bash
# docker compose: create a .env with DATABASE_URL, JWT_SECRET, INTERNAL_SECRET
docker compose up -d --build
```

or plain Docker:

```bash
docker run -d --name vds --restart unless-stopped -p 8766:80 \
  -e DATABASE_URL='postgres://USER:PW@HOST:5432/DB' \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e INTERNAL_SECRET="$(openssl rand -hex 16)" \
  -v /path/to/receipts:/app/public/receipts:ro \
  vorratsdatenspeicher
```

CI/CD (GitHub Actions in this repo) builds a **SHA-tagged image**, deploys it with a rolling update + automatic rollback, and **verifies the live `/api/version` SHA** before the run goes green — so a boot/migration crash that silently keeps the old version fails the pipeline.

**First login:** `martin` / `vorrat-start-2026` (override the initial password with `ADMIN_PASSWORD`; recover with `ADMIN_RESET=true`). Change it immediately in *Profile*.

## E-mail & offers

- **Inbound** (invoice import): per-user IMAP mailbox under *Profile → E-Mail-Postfach*, polled every ~15 min.
- **Outbound** (notifications): SMTP under *Admin → SMTP*.
- **Offers**: Marktguru — address & product categories under *Admin → Haushalt*.

> A guarded `POST /api/internal/recategorize-one` (header `X-Internal-Secret`) remains for external automation, but the old n8n / Telegram ingestion path is **deprecated** — OCR and e-mail import are now fully in-app.
