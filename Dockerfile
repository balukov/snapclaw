# syntax=docker/dockerfile:1

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
# Stage 2: Runtime — based on official openclaw image
# ============================================================
FROM ghcr.io/openclaw/openclaw:latest

USER root

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini gosu \
  && rm -rf /var/lib/apt/lists/*

# Install Telegram channel plugin dependencies into openclaw's node_modules
RUN OPENCLAW_DIR="$(dirname "$(readlink -f "$(which openclaw)")")" \
  && cd "$OPENCLAW_DIR/.." \
  && npm install grammy @grammyjs/runner @buape/carbon \
  || npm install --global grammy @grammyjs/runner @buape/carbon

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY skills ./skills

RUN chown -R node:node /app

# Prepare data directories (Railway mounts volume at /data)
RUN mkdir -p /data/.openclaw /data/workspace \
  && chown -R node:node /data

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

EXPOSE 3000

ENV NODE_ENV=production

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
