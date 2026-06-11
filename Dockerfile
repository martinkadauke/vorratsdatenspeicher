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
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ENV GIT_SHA=${GIT_SHA}
ENV GIT_REF=${GIT_REF}
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY --from=backend-build /app/backend/dist ./dist
COPY backend/migrations ./migrations
COPY --from=frontend-build /app/frontend/dist ./public
EXPOSE 80
CMD ["node", "dist/index.js"]
