# syntax=docker/dockerfile:1

# Pin the OpenClaw runtime image. Tracking `:latest` meant the underlying
# OpenClaw could change under SnapClaw without a deliberate redeploy — a
# rolling base that's hard to update predictably (Railway caches the layer)
# and a recurring source of surprise behavior changes. Bump this value to
# update OpenClaw; the build then re-pulls the new pinned digest.
ARG OPENCLAW_VERSION=2026.5.27

# ============================================================
# Stage 1: Build snapclaw (compile native modules + client JS + server TS)
# ============================================================
FROM node:22-bookworm AS builder

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
    tini gosu sudo \
  && rm -rf /var/lib/apt/lists/*

# Install Playwright's bundled Chromium for full browser tool support
# Per OpenClaw docs: must use bundled playwright-core CLI, NOT npx playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node /app/node_modules/playwright-core/cli.js install --with-deps chromium \
  && chown -R node:node /home/node/.cache

# Install Telegram channel plugin dependencies
# Install both in openclaw's dir and globally to ensure module resolution works
RUN OPENCLAW_DIR="$(dirname "$(readlink -f "$(which openclaw)")")" \
  && cd "$OPENCLAW_DIR/.." \
  && npm install grammy @grammyjs/runner @buape/carbon 2>/dev/null; \
  npm install --global grammy @grammyjs/runner @buape/carbon

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
RUN mkdir -p /data/.openclaw /data/workspace \
  && chown -R node:node /data

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Allow the unprivileged `node` gateway to re-own the plugin tree to root
# after onboarding installs the codex plugin (OpenClaw 2026.5.27+ blocks
# plugins not owned by root). The helper is root-owned, takes no arguments,
# and has a hardcoded target, so the NOPASSWD grant can't be abused.
COPY scripts/own-plugins.sh /usr/local/bin/snapclaw-own-plugins
RUN chown root:root /usr/local/bin/snapclaw-own-plugins \
  && chmod 0755 /usr/local/bin/snapclaw-own-plugins \
  && printf 'node ALL=(root) NOPASSWD: /usr/local/bin/snapclaw-own-plugins\n' \
       > /etc/sudoers.d/snapclaw \
  && chmod 0440 /etc/sudoers.d/snapclaw \
  && visudo -cf /etc/sudoers.d/snapclaw

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

EXPOSE 3000

ENV NODE_ENV=production

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node", "/snapclaw/dist/index.js"]
