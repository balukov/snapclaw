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

# Install Chromium via bundled Playwright CLI (avoids npm override conflicts)
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
RUN node /usr/lib/node_modules/openclaw/node_modules/playwright-core/cli.js install chromium \
  || npx -y playwright install chromium

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
