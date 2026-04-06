FROM node:22-bookworm

# System deps for node-pty and Playwright
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally
RUN npm install -g openclaw@latest

# Install Playwright Chromium system deps
RUN npx -y playwright install-deps chromium \
  && rm -rf /var/lib/apt/lists/*

# Install Chromium via OpenClaw's bundled playwright-core (avoids npm override conflicts)
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN PW_CLI=$(find /usr/local/lib -name "cli.js" -path "*/playwright-core/*" 2>/dev/null | head -1) \
  && node "$PW_CLI" install chromium

WORKDIR /app

# Install dependencies (including devDeps for build)
COPY package.json ./
RUN npm install && npm cache clean --force

# Copy source and build client
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY skills ./skills
RUN npm run build

# Railway injects PORT at runtime
EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["npx", "tsx", "src/index.ts"]
