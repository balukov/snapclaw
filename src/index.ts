import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import httpProxy from "http-proxy";
import { WebSocketServer, WebSocket } from "ws";
import pty from "node-pty";
import * as tar from "tar";

import {
  PORT,
  SETUP_PASSWORD,
  STATE_DIR,
  WORKSPACE_DIR,
  GATEWAY_TARGET,
  GATEWAY_TOKEN,
  INTERNAL_PORT,
  isConfigured,
  configPath,
  readConfig,
} from "./config.js";

import * as gateway from "./gateway.js";
import { runCmd, redactSecrets, sleep } from "./utils.js";

// --- Auth ---

const terminalTokens = new Map<string, number>();

function checkBasicAuth(req: http.IncomingMessage): boolean {
  if (!SETUP_PASSWORD) return true;
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return password === SETUP_PASSWORD;
}

function sendAuth(res: http.ServerResponse): void {
  res.setHeader("WWW-Authenticate", 'Basic realm="SnapClaw"');
  res.writeHead(401);
  res.end("Auth required");
}

function sendJson(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendFile(
  res: http.ServerResponse,
  filePath: string,
  contentType: string,
): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  return JSON.parse(body.toString("utf8"));
}

// --- Auth groups (for legacy form-based setup) ---

const AUTH_GROUPS = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex OAuth + API key",
    options: [
      { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      { value: "openai-api-key", label: "OpenAI API key" },
    ],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "Claude API key",
    options: [
      { value: "apiKey", label: "Anthropic API key" },
    ],
  },
  {
    value: "gemini",
    label: "Google Gemini",
    hint: "API key",
    options: [{ value: "gemini-api-key", label: "Gemini API key" }],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API key",
    options: [
      { value: "openrouter-api-key", label: "OpenRouter API key" },
    ],
  },
];

// --- Proxy ---

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err.message);
  if (res && "writeHead" in res && !res.headersSent) {
    (res as http.ServerResponse).writeHead(502, {
      "Content-Type": "application/json",
    });
    (res as http.ServerResponse).end(
      JSON.stringify({
        status: "error",
        code: 502,
        message: "Gateway unavailable",
      }),
    );
  }
});

// --- Terminal WebSocket ---

const termWss = new WebSocketServer({ noServer: true });

termWss.on("connection", (ws: WebSocket) => {
  const shell = pty.spawn("bash", [], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: WORKSPACE_DIR,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      TERM: "xterm-256color",
    } as Record<string, string>,
  });

  shell.onData((data: string) => {
    try {
      ws.send(data);
    } catch {}
  });

  ws.on("message", (msg: Buffer) => {
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        shell.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {}
    shell.write(str);
  });

  ws.on("close", () => shell.kill());
  shell.onExit(() => {
    try {
      ws.close();
    } catch {}
  });
});

// --- Route handler ---

const publicDir = new URL("../public", import.meta.url).pathname;

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // Health check — no auth
  if (url === "/healthz" || url === "/setup/healthz") {
    return sendJson(res, { ok: true });
  }

  // Static assets — no auth
  if (url === "/snapclaw-icon.png") {
    return sendFile(res, path.join(publicDir, "snapclaw-icon.png"), "image/png");
  }

  // --- Setup routes (require auth) ---
  if (url.startsWith("/setup")) {
    if (!checkBasicAuth(req)) return sendAuth(res);

    // Setup page
    if (url === "/setup" && method === "GET") {
      return sendFile(res, path.join(publicDir, "setup.html"), "text/html");
    }

    // Frontend JS
    if (url === "/setup/setup.js" && method === "GET") {
      return sendFile(res, path.join(publicDir, "setup.js"), "application/javascript");
    }

    // API: status
    if (url === "/setup/api/status" && method === "GET") {
      const r = await runCmd("openclaw", ["--version"]);
      return sendJson(res, {
        ok: true,
        configured: isConfigured(),
        openclawVersion: r.output.trim(),
        gatewayTarget: GATEWAY_TARGET,
      });
    }

    // API: auth groups
    if (url === "/setup/api/auth-groups" && method === "GET") {
      return sendJson(res, { ok: true, authGroups: AUTH_GROUPS });
    }

    // API: terminal token
    if (url === "/setup/api/terminal-token" && method === "GET") {
      const token = crypto.randomBytes(24).toString("hex");
      terminalTokens.set(token, Date.now() + 60_000);
      // Clean expired
      for (const [k, exp] of terminalTokens) {
        if (Date.now() > exp) terminalTokens.delete(k);
      }
      return sendJson(res, { token });
    }

    // API: config read
    if (url === "/setup/api/config/raw" && method === "GET") {
      const p = configPath();
      let content = "";
      let exists = false;
      try {
        content = fs.readFileSync(p, "utf8");
        exists = true;
      } catch {}
      return sendJson(res, { ok: true, path: p, exists, content });
    }

    // API: config write
    if (url === "/setup/api/config/raw" && method === "POST") {
      const body = await readJson(req);
      const content = String(body.content ?? "");
      if (content.length > 500_000) {
        return sendJson(res, { ok: false, error: "Too large" }, 400);
      }
      const p = configPath();
      // Backup
      try {
        if (fs.existsSync(p)) {
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          fs.copyFileSync(p, `${p}.bak-${ts}`);
        }
      } catch {}
      fs.writeFileSync(p, content, "utf8");
      await gateway.restart();
      return sendJson(res, { ok: true, path: p });
    }

    // API: run onboard
    if (url === "/setup/api/run" && method === "POST") {
      if (isConfigured()) {
        return sendJson(res, {
          ok: false,
          output: "Already configured. Use reset to reconfigure.",
        });
      }
      const body = await readJson(req);
      const args = buildOnboardArgs(body);
      const r = await runCmd("openclaw", args, 180_000);
      const output = redactSecrets(r.output);

      if (r.code === 0 && isConfigured()) {
        // Post-setup: sync config
        await runCmd("openclaw", ["config", "set", "gateway.auth.mode", "token"]);
        await runCmd("openclaw", ["config", "set", "gateway.auth.token", GATEWAY_TOKEN]);
        await runCmd("openclaw", ["config", "set", "gateway.remote.token", GATEWAY_TOKEN]);
        await runCmd("openclaw", ["config", "set", "gateway.bind", "loopback"]);
        await runCmd("openclaw", ["config", "set", "gateway.port", String(INTERNAL_PORT)]);
        await runCmd("openclaw", [
          "config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]',
        ]);

        // Set allowed origins
        const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
        if (domain) {
          await runCmd("openclaw", [
            "config", "set", "--json", "gateway.controlUi.allowedOrigins",
            JSON.stringify([`https://${domain}`, `http://localhost:${PORT}`]),
          ]);
        }

        await gateway.restart();
      }

      return sendJson(res, { ok: r.code === 0, output: `[setup] ${output}` });
    }

    // API: console
    if (url === "/setup/api/console/run" && method === "POST") {
      const body = await readJson(req);
      const cmd = String(body.cmd ?? "");
      const arg = String(body.arg ?? "").trim();

      const handlers: Record<string, () => Promise<string>> = {
        "gateway.restart": async () => {
          await gateway.restart();
          return "Gateway restarted.";
        },
        "gateway.stop": async () => {
          await gateway.stop();
          return "Gateway stopped.";
        },
        "gateway.start": async () => {
          await gateway.start();
          return "Gateway started.";
        },
      };

      if (handlers[cmd]) {
        const out = await handlers[cmd]();
        return sendJson(res, { ok: true, output: out });
      }

      // openclaw CLI commands
      const cliMap: Record<string, string[]> = {
        "openclaw.status": ["gateway", "status"],
        "openclaw.health": ["gateway", "health"],
        "openclaw.doctor": ["doctor", "--fix"],
        "openclaw.version": ["--version"],
        "openclaw.devices.list": ["devices", "list"],
        "openclaw.plugins.list": ["plugins", "list"],
      };

      const cliArgs = cliMap[cmd];
      if (cliArgs) {
        const extra = arg ? [arg] : [];
        const r = await runCmd("openclaw", [...cliArgs, ...extra]);
        return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
      }

      if (cmd === "openclaw.logs.tail") {
        const n = parseInt(arg) || 50;
        const r = await runCmd("openclaw", ["gateway", "call", "logs", "--tail", String(n)]);
        return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
      }

      if (cmd === "openclaw.config.get") {
        const r = await runCmd("openclaw", ["config", "get", arg || "."]);
        return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
      }

      if (cmd === "openclaw.devices.approve" && arg) {
        if (!/^[A-Za-z0-9_-]+$/.test(arg)) {
          return sendJson(res, { ok: false, error: "Invalid ID" }, 400);
        }
        const r = await runCmd("openclaw", ["devices", "approve", arg]);
        return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
      }

      if (cmd === "openclaw.plugins.enable" && arg) {
        const r = await runCmd("openclaw", ["plugins", "enable", arg]);
        return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
      }

      return sendJson(res, { ok: false, error: "Unknown command" }, 400);
    }

    // API: pairing approve
    if (url === "/setup/api/pairing/approve" && method === "POST") {
      const body = await readJson(req);
      const channel = String(body.channel ?? "").trim();
      const code = String(body.code ?? "").trim();
      if (!channel || !code) {
        return sendJson(res, { ok: false, error: "Missing channel or code" }, 400);
      }
      const r = await runCmd("openclaw", ["pairing", "approve", channel, code]);
      return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // API: devices pending
    if (url === "/setup/api/devices/pending" && method === "GET") {
      const r = await runCmd("openclaw", ["devices", "list", "--json"]);
      let requestIds: string[] = [];
      try {
        const parsed = JSON.parse(r.output);
        requestIds = (parsed.pending ?? [])
          .map((d: Record<string, unknown>) => d.requestId)
          .filter(Boolean) as string[];
      } catch {}
      return sendJson(res, { ok: r.code === 0, requestIds, output: redactSecrets(r.output) });
    }

    // API: devices approve
    if (url === "/setup/api/devices/approve" && method === "POST") {
      const body = await readJson(req);
      const id = String(body.requestId ?? "").trim();
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
        return sendJson(res, { ok: false, error: "Invalid ID" }, 400);
      }
      const r = await runCmd("openclaw", ["devices", "approve", id]);
      return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // API: reset
    if (url === "/setup/api/reset" && method === "POST") {
      await gateway.stop();
      try {
        fs.unlinkSync(configPath());
      } catch {}
      return sendJson(res, { ok: true, output: "Config deleted. Run setup again." });
    }

    // Export backup
    if (url === "/setup/export" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="snapclaw-backup.tar.gz"',
      });
      await tar.create({ gzip: true, cwd: "/data" }, ["."]).pipe(res);
      return;
    }

    // Import backup
    if (url === "/setup/import" && method === "POST") {
      const body = await readBody(req);
      await tar.extract({ cwd: "/data", gzip: true }, []).end(body);
      if (isConfigured()) await gateway.restart();
      return sendJson(res, { ok: true, output: "Backup imported." });
    }

    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // --- Everything else: proxy to gateway ---

  if (!isConfigured()) {
    res.writeHead(302, { Location: "/setup" });
    res.end();
    return;
  }

  try {
    await gateway.ensure();
  } catch {
    res.writeHead(502);
    res.end("Gateway not ready. Visit /setup for troubleshooting.");
    return;
  }

  // Inject gateway auth token
  if (!req.headers.authorization && GATEWAY_TOKEN) {
    req.headers.authorization = `Bearer ${GATEWAY_TOKEN}`;
  }

  proxy.web(req, res, { target: GATEWAY_TARGET });
}

// --- Onboard args builder ---

function buildOnboardArgs(body: Record<string, unknown>): string[] {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--skip-health",
    "--flow",
    String(body.flow ?? "quickstart"),
    "--mode",
    "local",
    "--gateway-port",
    String(INTERNAL_PORT),
    "--gateway-bind",
    "loopback",
    "--gateway-auth",
    "token",
    "--gateway-token-ref-env",
    "OPENCLAW_GATEWAY_TOKEN",
    "--no-install-daemon",
  ];

  const choice = String(body.authChoice ?? "");
  const secret = String(body.authSecret ?? "").trim();

  if (choice) args.push("--auth-choice", choice);

  const keyFlags: Record<string, string> = {
    "openai-api-key": "--openai-api-key",
    apiKey: "--anthropic-api-key",
    "gemini-api-key": "--gemini-api-key",
    "openrouter-api-key": "--openrouter-api-key",
  };

  if (keyFlags[choice] && secret) {
    args.push(keyFlags[choice], secret);
  } else if (choice === "token" && secret) {
    args.push("--token-provider", "anthropic", "--token", secret);
  }

  return args;
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  }
});

// WebSocket upgrade
server.on("upgrade", (req, socket, head) => {
  const url = req.url ?? "";

  // Terminal WebSocket
  if (url.startsWith("/setup/terminal")) {
    const params = new URL(url, `http://localhost`).searchParams;
    const token = params.get("token");
    if (!token || !terminalTokens.has(token) || Date.now() > terminalTokens.get(token)!) {
      socket.destroy();
      return;
    }
    terminalTokens.delete(token);
    termWss.handleUpgrade(req, socket, head, (ws) => {
      termWss.emit("connection", ws, req);
    });
    return;
  }

  // Gateway WebSocket proxy
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  if (!req.headers.authorization && GATEWAY_TOKEN) {
    req.headers.authorization = `Bearer ${GATEWAY_TOKEN}`;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

// Start
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`[snapclaw] listening on :${PORT}`);
  console.log(`[snapclaw] state: ${STATE_DIR}`);
  console.log(`[snapclaw] gateway target: ${GATEWAY_TARGET}`);

  // Ensure directories exist
  fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  // Auto-start gateway if configured
  if (isConfigured()) {
    console.log("[snapclaw] starting gateway...");
    try {
      await gateway.start();
      console.log("[snapclaw] gateway ready");
    } catch (err) {
      console.error("[snapclaw] gateway failed:", err);
    }
  }
});

process.on("SIGTERM", () => {
  gateway.stop();
  server.close();
});
