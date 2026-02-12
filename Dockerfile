# =============================================================================
# MULTI-STAGE DOCKERFILE — Energy Ingestion Engine
# =============================================================================
# Stage 1: Install dependencies (cached layer)
# Stage 2: Build TypeScript → JavaScript
# Stage 3: Production image (minimal, no devDeps, no source)
#
# Final image: ~180MB (node:22-alpine base + prod deps + compiled JS)
# =============================================================================

# ── Stage 1: Dependencies ────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy only package files — this layer is cached until deps change
COPY package.json package-lock.json* ./

# Install ALL deps (dev included — needed for build stage)
# --ignore-scripts: skip postinstall scripts that may fail in Alpine
RUN npm ci --ignore-scripts

# ── Stage 2: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json nest-cli.json ./
COPY src ./src

RUN npx nest build

# ── Stage 3: Production ─────────────────────────────────────────────────────
FROM node:22-alpine AS production

# Security: run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Copy database schema for reference (useful for init containers)
COPY database ./database

# Own everything by the non-root user
RUN chown -R appuser:appgroup /app

USER appuser

# Fastify listens on 3000
EXPOSE 3000

# Health check — Fastify responds on /v1/telemetry/buffer-status
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/v1/telemetry/buffer-status || exit 1

CMD ["node", "dist/main"]
