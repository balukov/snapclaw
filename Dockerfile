# syntax=docker/dockerfile:1

# ============================================================
# Stage 1: Build (compile native modules + client JS + server TS)
# ============================================================
FROM node:22-bookworm AS builder

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Layer-cache: deps first (only re-runs when lockfile changes) ---
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm ci

# --- Copy source & build ---
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

# Strip devDependencies
RUN npm prune --omit=dev

# ============================================================
# Stage 2: Runtime (slim, non-root)
# ============================================================
FROM node:22-bookworm-slim

ARG EXTRA_APT_PACKAGES=""
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini gosu ${EXTRA_APT_PACKAGES} \
  && rm -rf /var/lib/apt/lists/*

# Pin openclaw version for reproducibility
ARG OPENCLAW_VERSION=2026.4.8
RUN npm install -g openclaw@${OPENCLAW_VERSION}

# Install Playwright Chromium + system deps (using openclaw's bundled playwright-core)
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node /usr/local/lib/node_modules/openclaw/node_modules/playwright-core/cli.js install --with-deps chromium \
  && chown -R node:node /home/node/.cache

WORKDIR /app

# --- Copy compiled output only (no src/ or tsconfig at runtime) ---
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY skills ./skills

RUN chown -R node:node /app

# Prepare data directories
RUN mkdir -p /data/.openclaw /data/workspace \
  && chown -R node:node /data

# Entrypoint (permission fixup for Railway volumes, then drop to node user)
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

EXPOSE 3000

ENV NODE_ENV=production

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
