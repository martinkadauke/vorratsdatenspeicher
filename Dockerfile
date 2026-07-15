# ── build frontend ─────────────────────────────────────
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── build backend ──────────────────────────────────────
FROM node:20-alpine AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# ── runtime ────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# pg_dump (super-admin backup) + GNU tar for the backup archive stream
RUN apk add --no-cache postgresql-client tar
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ENV GIT_SHA=${GIT_SHA}
ENV GIT_REF=${GIT_REF}
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --from=backend-build /app/backend/dist ./dist
COPY backend/migrations ./migrations
COPY --from=frontend-build /app/frontend/dist ./public
# The app reads PORT (config default is 3000). Pin it to 80 so the naked image matches
# EXPOSE 80 and every documented `-p <host>:80` mapping works with no extra env — otherwise
# `docker run -p 8766:80` hits nothing (the app would be on :3000). Deploy stacks may still
# override PORT via env.
ENV PORT=80
EXPOSE 80
CMD ["node", "dist/index.js"]
