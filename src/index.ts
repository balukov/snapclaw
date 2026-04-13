import http from "node:http";
import { execSync } from "node:child_process";
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

const SESSION_SECRET = crypto.randomBytes(16).toString("hex");

function makeSessionToken(): string {
  const hmac = crypto.createHmac("sha256", SESSION_SECRET);
  hmac.update(SETUP_PASSWORD);
  return hmac.digest("hex");
}

function checkAuth(req: http.IncomingMessage): boolean {
  if (!SETUP_PASSWORD) return true;
  // Check session cookie
  const cookies = req.headers.cookie ?? "";
  const match = cookies.match(/snapclaw_session=([a-f0-9]+)/);
  if (match && match[1] === makeSessionToken()) return true;
  // Also accept basic auth for API clients
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    return password === SETUP_PASSWORD;
  }
  return false;
}

function sendLoginPage(res: http.ServerResponse, error = ""): void {
  const errorHtml = error ? `<p style="color:var(--accent);margin-bottom:1rem;font-size:.9rem">${error}</p>` : "";
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SnapClaw</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;--accent:#e85d3a;--accent-glow:rgba(232,93,58,0.15);--text:#e8e6e3;--muted:#8b8a88;--r:14px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:2rem;width:100%;max-width:360px;margin:1rem}
h1{font-size:1.4rem;font-weight:700;margin-bottom:.25rem;background:linear-gradient(135deg,var(--text),var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
p{color:var(--muted);font-size:.85rem;margin-bottom:1.25rem}
input{width:100%;padding:.7rem .85rem;border:1px solid var(--border);border-radius:10px;font-size:.95rem;font-family:'JetBrains Mono',monospace;background:var(--bg);color:var(--text);margin-bottom:1rem}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
button{width:100%;padding:.75rem;border-radius:10px;border:0;background:var(--accent);color:#fff;font-weight:700;font-size:.95rem;font-family:'DM Sans',sans-serif;cursor:pointer;transition:all .2s}
button:hover{filter:brightness(1.1);transform:translateY(-1px);box-shadow:0 4px 16px rgba(232,93,58,.3)}
</style></head><body>
<form class="card" method="POST" action="/snapclaw/login">
<h1>SnapClaw</h1>
<p>Enter your setup password</p>
${errorHtml}
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Log in</button>
</form></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
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

// --- Channel readiness ---

let channelsReady = false;
let cachedVersion = "";

async function checkChannelsReady(): Promise<boolean> {
  try {
    const cfg = readConfig();
    const plugins = (cfg as Record<string, unknown>)?.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    if (entries && Object.keys(entries).some(k => ["telegram", "discord", "whatsapp"].includes(k))) {
      channelsReady = true;
      return true;
    }
  } catch {}
  // Fallback: check via CLI
  try {
    const r = await runCmd("openclaw", ["channels", "list"], 10_000);
    if (r.code === 0 && r.output.toLowerCase().match(/telegram|discord|whatsapp/)) {
      channelsReady = true;
      return true;
    }
  } catch {}
  return false;
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

  // Allow Control UI connections without device pairing
  await runCmd("openclaw", [
    "config", "set", "--json", "gateway.controlUi.dangerouslyDisableDeviceAuth", "true",
  ]);
  await runCmd("openclaw", [
    "config", "set", "--json", "gateway.controlUi.allowInsecureAuth", "true",
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

// --- Codex OAuth session (background PTY) ---

interface CodexSession {
  pty: ReturnType<typeof pty.spawn>;
  oauthUrl: string | null;
  status: "waiting" | "done" | "error";
  output: string;
}

let codexSession: CodexSession | null = null;

function resolveOpenclawDir(): string {
  try {
    const bin = fs.realpathSync(
      execSync("which openclaw", { encoding: "utf8" }).trim(),
    );
    let dir = path.dirname(bin);
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(dir, "docs", "reference", "templates"))) return dir;
      dir = path.dirname(dir);
    }
  } catch {}
  return "/tmp";
}

const openclawDir = resolveOpenclawDir();

function startCodexSession(): CodexSession {
  // Remove existing config so onboard doesn't ask about it
  try { fs.unlinkSync(configPath()); } catch {}

  const shell = pty.spawn("openclaw", [
    "onboard",
    "--accept-risk",
    "--skip-health",
    "--skip-channels",
    "--skip-skills",
    "--skip-ui",
    "--skip-search",
    "--no-install-daemon",
    "--auth-choice", "openai-codex",
    "--flow", "quickstart",
    "--mode", "local",
    "--gateway-port", String(INTERNAL_PORT),
    "--gateway-bind", "loopback",
    "--gateway-auth", "token",
    "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN",
  ], {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: openclawDir,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      TERM: "xterm-256color",
    } as Record<string, string>,
  });

  const session: CodexSession = { pty: shell, oauthUrl: null, status: "waiting", output: "" };

  shell.onData((data: string) => {
    session.output += data;
    const clean = data.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "");

    // Capture OAuth URL
    if (!session.oauthUrl) {
      const allClean = session.output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "");
      const urls = allClean.match(/https?:\/\/[^\s"'<>\x00-\x1f]+/g);
      if (urls) {
        session.oauthUrl = urls[urls.length - 1];
        console.log("[codex] found OAuth URL:", session.oauthUrl);
      }
    }

    // Once config is written, auth succeeded — kill the PTY
    // (onboard may hang on hooks prompt after this)
    if (clean.includes("Updated") && clean.includes("openclaw.json")) {
      console.log("[codex] config written, finishing session");
      session.status = "done";
      setTimeout(() => { try { shell.kill(); } catch {} }, 500);
    }
  });

  shell.onExit(({ exitCode }) => {
    session.status = (exitCode === 0 || isConfigured()) ? "done" : "error";
    console.log(`[codex] exited code=${exitCode} status=${session.status}`);
  });

  codexSession = session;

  // Auto-cleanup after 5 min
  setTimeout(() => {
    if (codexSession === session) {
      try { shell.kill(); } catch {}
      codexSession = null;
    }
  }, 300_000);

  return session;
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
  if (url === "/healthz" || url === "/snapclaw/healthz") {
    return sendJson(res, { ok: true });
  }

  // Static assets — no auth
  if (url === "/snapclaw-icon.png") {
    return sendFile(res, path.join(publicDir, "snapclaw-icon.png"), "image/png");
  }

  // --- Setup routes (require auth) ---
  if (url.startsWith("/snapclaw")) {
    // Login form POST
    if (url === "/snapclaw/login" && method === "POST") {
      const body = await readBody(req);
      const params = new URLSearchParams(body.toString("utf8"));
      const password = params.get("password") ?? "";
      if (password === SETUP_PASSWORD) {
        res.writeHead(302, {
          Location: "/snapclaw",
          "Set-Cookie": `snapclaw_session=${makeSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
        });
        res.end();
        return;
      }
      return sendLoginPage(res, "Wrong password");
    }

    // Show login page if not authenticated
    if (!checkAuth(req)) {
      return sendLoginPage(res);
    }

    // Setup page
    if (url === "/snapclaw" && method === "GET") {
      return sendFile(res, path.join(publicDir, "setup.html"), "text/html");
    }

    // Frontend JS
    if (url === "/snapclaw/setup.js" && method === "GET") {
      return sendFile(res, path.join(publicDir, "setup.js"), "application/javascript");
    }

    // API: status
    if (url === "/snapclaw/api/status" && method === "GET") {
      if (!channelsReady) {
        // Check config first (fast), only fall back to CLI if needed
        const cfgCheck = readConfig();
        const pluginEntries = (cfgCheck?.plugins as Record<string, unknown>)?.entries as Record<string, unknown> | undefined;
        if (pluginEntries && Object.keys(pluginEntries).some(k => ["telegram", "discord", "whatsapp"].includes(k))) {
          channelsReady = true;
        }
      }
      const cfg = readConfig();
      const channels = cfg?.channels as Record<string, unknown> | undefined;
      const tg = channels?.telegram as Record<string, unknown> | undefined;
      const botTokenSet = !!(tg?.botToken);
      // Extract model name from agents.defaults.model or top-level
      const agents = cfg?.agents as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      const model = (defaults?.model as string) ?? null;
      return sendJson(res, {
        ok: true,
        configured: isConfigured(),
        channelsReady,
        botTokenSet,
        model,
        openclawVersion: cachedVersion,
        gatewayTarget: GATEWAY_TARGET,
      });
    }

    // API: codex OAuth start
    if (url === "/snapclaw/api/codex/start" && method === "POST") {
      if (codexSession) {
        try { codexSession.pty.kill(); } catch {}
        codexSession = null;
      }

      try {
        const session = startCodexSession();
        // Wait up to 30s for OAuth URL
        const deadline = Date.now() + 30_000;
        while (!session.oauthUrl && session.status === "waiting" && Date.now() < deadline) {
          await sleep(500);
        }
        return sendJson(res, {
          ok: true,
          oauthUrl: session.oauthUrl,
          status: session.status,
        });
      } catch (err: any) {
        return sendJson(res, { ok: false, error: err.message ?? String(err) }, 500);
      }
    }

    // API: codex OAuth callback
    if (url === "/snapclaw/api/codex/callback" && method === "POST") {
      const body = await readJson(req);
      const redirectUrl = String(body.redirectUrl ?? "").trim();
      if (!redirectUrl) return sendJson(res, { ok: false, error: "Missing redirectUrl" }, 400);
      if (!codexSession?.pty) return sendJson(res, { ok: false, error: "No active session" }, 400);

      codexSession.pty.write(redirectUrl + "\r");

      // Wait for completion
      const deadline = Date.now() + 60_000;
      while (codexSession.status === "waiting" && Date.now() < deadline) {
        await sleep(500);
      }

      const ok = codexSession.status === "done";
      if (ok) {
        await applyPostSetupConfig();
        await gateway.restart();
      }
      const result = { ok, status: codexSession.status };
      codexSession = null;
      return sendJson(res, result);
    }

    // API: telegram add
    if (url === "/snapclaw/api/telegram/add" && method === "POST") {
      const body = await readJson(req);
      const token = String(body.token ?? "").trim();
      if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
        return sendJson(res, { ok: false, error: "Invalid bot token format" }, 400);
      }
      const r = await runCmd("openclaw", [
        "config", "set", "channels.telegram.botToken", token,
      ]);
      if (r.code === 0) {
        channelsReady = true;
        await gateway.restart();
      }
      return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // API: terminal token
    if (url === "/snapclaw/api/terminal-token" && method === "GET") {
      const token = crypto.randomBytes(24).toString("hex");
      terminalTokens.set(token, Date.now() + 60_000);
      // Clean expired
      for (const [k, exp] of terminalTokens) {
        if (Date.now() > exp) terminalTokens.delete(k);
      }
      return sendJson(res, { token });
    }

    // API: config read
    if (url === "/snapclaw/api/config/raw" && method === "GET") {
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
    if (url === "/snapclaw/api/config/raw" && method === "POST") {
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
    if (url === "/snapclaw/api/onboard" && method === "POST") {
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
    if (url === "/snapclaw/api/console/run" && method === "POST") {
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
    if (url === "/snapclaw/api/pairing/approve" && method === "POST") {
      const body = await readJson(req);
      const channel = String(body.channel ?? "").trim();
      const code = String(body.code ?? "").trim();
      if (!channel || !code) {
        return sendJson(res, { ok: false, error: "Missing channel or code" }, 400);
      }
      const r = await runCmd("openclaw", ["pairing", "approve", channel, code]);
      if (r.code === 0) {
        channelsReady = true;
      }
      return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // API: devices pending
    if (url === "/snapclaw/api/devices/pending" && method === "GET") {
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
    if (url === "/snapclaw/api/devices/approve" && method === "POST") {
      const body = await readJson(req);
      const id = String(body.requestId ?? "").trim();
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
        return sendJson(res, { ok: false, error: "Invalid ID" }, 400);
      }
      const r = await runCmd("openclaw", ["devices", "approve", id]);
      return sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
    }

    // API: reset
    if (url === "/snapclaw/api/reset" && method === "POST") {
      await gateway.stop();
      try {
        fs.unlinkSync(configPath());
      } catch {}
      return sendJson(res, { ok: true, output: "Config deleted. Run setup again." });
    }

    // Export backup
    if (url === "/snapclaw/export" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Disposition": 'attachment; filename="snapclaw-backup.tar.gz"',
      });
      await tar.create({ gzip: true, cwd: "/data" }, ["."]).pipe(res);
      return;
    }

    // Import backup
    if (url === "/snapclaw/import" && method === "POST") {
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
    res.writeHead(302, { Location: "/snapclaw" });
    res.end();
    return;
  }

  // Redirect root to /snapclaw until channels are configured
  if (url === "/" && !channelsReady) {
    res.writeHead(302, { Location: "/snapclaw" });
    res.end();
    return;
  }

  try {
    await gateway.ensure();
  } catch {
    res.writeHead(302, { Location: "/snapclaw" });
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
  if (url.startsWith("/snapclaw/terminal")) {
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

  // Cache version string
  try {
    const v = await runCmd("openclaw", ["--version"], 10_000);
    cachedVersion = v.output.trim();
  } catch {}

  // Ensure directories exist
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });
  try {
    fs.chmodSync(STATE_DIR, 0o700);
  } catch {}

  // Auto-onboard if not configured
  if (!isConfigured()) {
    console.log("[snapclaw] first start — auto-onboarding...");
    await autoOnboard();
  }

  // Start gateway if configured
  if (isConfigured()) {
    await checkChannelsReady();
    console.log(`[snapclaw] starting gateway... (channels ready: ${channelsReady})`);
    try {
      await gateway.start();
      console.log("[snapclaw] gateway ready");
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
