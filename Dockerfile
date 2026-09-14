# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ── Production dependencies only ──────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Compile TypeScript ────────────────────────────────────────────────────
FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────
FROM base AS runtime
ENV AUTH_DIR=/app/data/auth \
    MIGRATIONS_DIR=/app/src/db/migrations

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/db/migrations ./src/db/migrations

# AUTH_DIR lives INSIDE the volume (not as the mount point itself) so the
# daemon can rename it on logout without hitting EBUSY.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]

CMD ["node", "--enable-source-maps", "dist/index.js"]
