# ============================================================
# Stage 1: Build (compile native modules + client JS)
# ============================================================
FROM node:22-bookworm AS builder

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

# Strip devDependencies (esbuild, typescript, @types/*)
RUN npm prune --omit=dev

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM node:22-bookworm

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini gosu \
  && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally
RUN npm install -g openclaw@latest

# Install Playwright Chromium system deps (needed for headless Chrome in Docker)
RUN npx playwright install-deps chromium \
  && rm -rf /var/lib/apt/lists/*

# Install Chromium browser binary via OpenClaw's bundled playwright-core.
# Use find to locate the CLI — resilient to dependency hoisting and version changes.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN PW_CLI=$(find /usr/local/lib/node_modules -path '*/playwright-core/cli.js' -print -quit) \
  && test -n "$PW_CLI" \
  && echo "playwright-core CLI: $PW_CLI" \
  && node "$PW_CLI" install chromium \
  && chown -R node:node /home/node/.cache

WORKDIR /app

# Copy built app from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY src ./src
COPY tsconfig.json ./
COPY skills ./skills

RUN chown -R node:node /app

# Prepare data directories (Railway mounts volume at /data)
RUN mkdir -p /data/.openclaw /data/workspace \
  && chown -R node:node /data

# Entrypoint script for volume permission fixup
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

EXPOSE 8080

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/index.ts"]
