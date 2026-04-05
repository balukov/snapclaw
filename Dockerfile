FROM node:22-bookworm

# System deps for node-pty and Playwright
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally
RUN npm install -g openclaw@latest

# Install Playwright Chromium for built-in browser plugin
RUN npx -y playwright install-deps chromium \
  && npx -y playwright install chromium \
  && rm -rf /var/lib/apt/lists/*

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
