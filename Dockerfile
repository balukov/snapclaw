# syntax=docker/dockerfile:1

# Pin the OpenClaw runtime image. Tracking `:latest` meant the underlying
# OpenClaw could change under SnapClaw without a deliberate redeploy — a
# rolling base that's hard to update predictably (Railway caches the layer)
# and a recurring source of surprise behavior changes. Bump this value to
# update OpenClaw; the build then re-pulls the new pinned digest.
ARG OPENCLAW_VERSION=2026.9.2

# ============================================================
# Stage 1: Build snapclaw (compile native modules + client JS + server TS)
# ============================================================
FROM node:24-bookworm AS builder

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

RUN npm prune --omit=dev

# ============================================================
# Stage 2: Runtime — based on official openclaw image (pinned, see top ARG)
# ============================================================
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

USER root

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini gosu \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --allow-scripts=better-sqlite3 obsidian-headless@0.0.14 \
  && ob --version \
  && node -e "require('/usr/local/lib/node_modules/obsidian-headless/node_modules/better-sqlite3')"
ENV XDG_CONFIG_HOME=/data/.config

# Install Playwright's bundled Chromium for full browser tool support
# Per OpenClaw docs: must use bundled playwright-core CLI, NOT npx playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node /app/node_modules/playwright-core/cli.js install --with-deps chromium \
  && chown -R node:node /home/node/.cache

WORKDIR /snapclaw

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

RUN chown -R node:node /snapclaw

# Git config for the agent
RUN git config --system user.name "OpenClaw Agent" \
  && git config --system user.email "agent@openclaw.local"

# Prepare data directories (Railway mounts volume at /data)
RUN mkdir -p /data/.openclaw \
  && chown -R node:node /data

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

EXPOSE 3000

ENV NODE_ENV=production

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node", "/snapclaw/dist/index.js"]
