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

// --- Auto-configure helpers ---

async function applyPostSetupConfig(): Promise<void> {
  await runCmd("openclaw", ["config", "set", "gateway.auth.mode", "token"]);
  await runCmd("openclaw", ["config", "set", "gateway.auth.token", GATEWAY_TOKEN]);
  await runCmd("openclaw", ["config", "set", "gateway.remote.token", GATEWAY_TOKEN]);
  await runCmd("openclaw", ["config", "set", "gateway.bind", "loopback"]);
  await runCmd("openclaw", ["config", "set", "gateway.port", String(INTERNAL_PORT)]);
  await runCmd("openclaw", [
    "config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]',
  ]);

  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (domain) {
    await runCmd("openclaw", [
      "config", "set", "--json", "gateway.controlUi.allowedOrigins",
      JSON.stringify([`https://${domain}`, `http://localhost:${PORT}`]),
    ]);
  }
}

async function autoOnboard(): Promise<boolean> {
  console.log("[snapclaw] auto-onboarding...");
  const r = await runCmd("openclaw", [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--skip-health",
    "--flow", "quickstart",
    "--mode", "local",
    "--gateway-port", String(INTERNAL_PORT),
    "--gateway-bind", "loopback",
    "--gateway-auth", "token",
    "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN",
    "--no-install-daemon",
  ], 180_000);

  if (r.code === 0 && isConfigured()) {
    console.log("[snapclaw] onboarding complete, applying config...");
    await applyPostSetupConfig();
    return true;
  }
  console.error("[snapclaw] onboarding failed:", redactSecrets(r.output));
  return false;
}

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
    cwd: fs.existsSync(WORKSPACE_DIR) ? WORKSPACE_DIR : "/tmp",
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

    // API: codex OAuth start
    if (url === "/setup/api/codex/start" && method === "POST") {
      const r = await runCmd("openclaw", [
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--skip-health",
        "--flow", "quickstart",
        "--mode", "local",
        "--auth-choice", "codex-cli",
        "--gateway-port", String(INTERNAL_PORT),
        "--gateway-bind", "loopback",
        "--gateway-auth", "token",
        "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN",
        "--no-install-daemon",
      ], 60_000);
      const output = redactSecrets(r.output);
      // Parse OAuth URL from output
      const urlMatch = output.match(/https?:\/\/[^\s"'<>]+oauth[^\s"'<>]*/i)
        ?? output.match(/https?:\/\/[^\s"'<>]+login[^\s"'<>]*/i)
        ?? output.match(/https?:\/\/[^\s"'<>]+auth[^\s"'<>]*/i);
      return sendJson(res, {
        ok: r.code === 0,
        oauthUrl: urlMatch ? urlMatch[0] : null,
        output,
      });
    }

    // API: codex OAuth callback
    if (url === "/setup/api/codex/callback" && method === "POST") {
      const body = await readJson(req);
      const redirectUrl = String(body.redirectUrl ?? "").trim();
      if (!redirectUrl) {
        return sendJson(res, { ok: false, error: "Missing redirectUrl" }, 400);
      }
      // Pass the redirect URL to openclaw to complete OAuth
      const r = await runCmd("openclaw", ["auth", "callback", redirectUrl], 30_000);
      if (r.code === 0) {
        await applyPostSetupConfig();
        await gateway.restart();
      }
      return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // API: telegram add
    if (url === "/setup/api/telegram/add" && method === "POST") {
      const body = await readJson(req);
      const token = String(body.token ?? "").trim();
      if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        return sendJson(res, { ok: false, error: "Invalid bot token format" }, 400);
      }
      const r = await runCmd("openclaw", [
        "channels", "add", "--channel", "telegram", "--token", token,
      ]);
      if (r.code === 0) {
        await gateway.restart();
      }
      return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // API: telegram verify
    if (url === "/setup/api/telegram/verify" && method === "GET") {
      const r = await runCmd("openclaw", ["channels", "list"]);
      const hasTelegram = r.output.toLowerCase().includes("telegram");
      return sendJson(res, { ok: true, connected: hasTelegram, output: redactSecrets(r.output) });
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

    // API: trigger auto-onboard (if not yet configured)
    if (url === "/setup/api/onboard" && method === "POST") {
      if (isConfigured()) {
        return sendJson(res, { ok: true, output: "Already configured." });
      }
      const ok = await autoOnboard();
      if (ok) {
        await gateway.restart();
      }
      return sendJson(res, { ok, output: ok ? "Configured." : "Onboarding failed." });
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
    res.writeHead(302, { Location: "/setup" });
    res.end();
    return;
  }

  // Inject gateway auth token
  if (!req.headers.authorization && GATEWAY_TOKEN) {
    req.headers.authorization = `Bearer ${GATEWAY_TOKEN}`;
  }

  proxy.web(req, res, { target: GATEWAY_TARGET });
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
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  // Copy bundled skills to workspace if not already there
  const bundledSkillsDir = path.join(process.cwd(), "skills");
  try {
    if (fs.existsSync(bundledSkillsDir)) {
      const skillsTarget = path.join(WORKSPACE_DIR, "skills");
      fs.mkdirSync(skillsTarget, { recursive: true });
      for (const skill of fs.readdirSync(bundledSkillsDir)) {
        const dest = path.join(skillsTarget, skill);
        if (!fs.existsSync(dest)) {
          fs.cpSync(path.join(bundledSkillsDir, skill), dest, { recursive: true });
          console.log(`[snapclaw] installed skill: ${skill}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[snapclaw] failed to copy skills: ${err}`);
  }

  // Auto-onboard if not configured
  if (!isConfigured()) {
    console.log("[snapclaw] first start — auto-onboarding...");
    await autoOnboard();
  }

  // Start gateway if configured
  if (isConfigured()) {
    console.log("[snapclaw] starting gateway...");
    try {
      await gateway.start();
      console.log("[snapclaw] gateway ready");

      // Set up memory-sleep cron if not already configured
      try {
        const cronCheck = await runCmd("openclaw", ["cron", "list"]);
        if (!cronCheck.output.includes("memory-sleep") && !cronCheck.output.includes("dream")) {
          await runCmd("openclaw", [
            "cron", "add",
            "--schedule", "0 3 * * *",
            "--task", "Execute memory-sleep skill: consolidate memory",
            "--label", "memory-sleep",
          ]);
          console.log("[snapclaw] cron: memory-sleep nightly at 3 AM");
        }
      } catch {}
    } catch (err) {
      console.error("[snapclaw] gateway failed:", err);
    }
  }
});

process.on("SIGTERM", async () => {
  console.log("[snapclaw] SIGTERM received, shutting down...");
  server.close();
  await gateway.stop();
  process.exit(0);
});
