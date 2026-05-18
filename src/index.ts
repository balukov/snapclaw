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
import { ensurePersistentLinks, runCmd, redactSecrets, sleep } from "./utils.js";

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
  const errorHtml = error ? `<p class="error">${error}</p>` : "";
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SnapClaw</title>
<link rel="icon" type="image/png" href="/snapclaw-icon.png">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0f1117;--surface-1:#1a1d27;--surface-2:#14171f;--border:#2a2d3a;--border-strong:#3a3d4a;--text:#e8e6e3;--text-muted:#8b8a88;--text-faint:#5a5a58;--accent:#e85d3a;--accent-hover:#ed6e4d;--accent-fg:#fff;--accent-glow:rgba(232,93,58,0.18);--radius-sm:8px;--radius-lg:16px;--font-sans:'DM Sans',system-ui,sans-serif;--font-mono:'JetBrains Mono',ui-monospace,monospace;--ease:cubic-bezier(0.16,1,0.3,1)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font-sans);background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(232,93,58,0.015) 1px,transparent 1px),linear-gradient(90deg,rgba(232,93,58,0.015) 1px,transparent 1px);background-size:96px 96px;pointer-events:none;z-index:0}
.card{position:relative;z-index:1;background:var(--surface-1);border:1px solid var(--border);border-radius:var(--radius-lg);padding:32px;width:100%;max-width:360px;margin:16px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.04),0 1px 2px rgba(0,0,0,0.4)}
h1{font-size:1.4rem;font-weight:700;letter-spacing:-0.02em;color:var(--text);margin-bottom:4px}
p{color:var(--text-muted);font-size:.85rem;margin-bottom:20px;line-height:1.5}
.error{color:var(--accent);font-size:.85rem;margin-bottom:16px}
input{width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:.85rem;font-family:var(--font-mono);background:var(--surface-2);color:var(--text);margin-bottom:12px;transition:border-color 150ms var(--ease),box-shadow 150ms var(--ease)}
input::placeholder{color:var(--text-faint)}
input:focus-visible{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
button{width:100%;padding:10px;border-radius:var(--radius-sm);border:1px solid transparent;background:var(--accent);color:var(--accent-fg);font-weight:700;font-size:.85rem;font-family:var(--font-sans);cursor:pointer;transition:background-color 150ms var(--ease),box-shadow 150ms var(--ease)}
button:hover{background:var(--accent-hover);box-shadow:0 2px 8px rgba(232,93,58,.18)}
button:active{filter:brightness(0.95)}
button:focus-visible{outline:none;box-shadow:0 0 0 3px var(--accent-glow)}
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

const CHANNEL_RE = /telegram|discord|whatsapp/i;
const CHANNELS_READY_FLAG = path.join(STATE_DIR, ".channels-ready");

function markChannelsReady(): void {
  channelsReady = true;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CHANNELS_READY_FLAG, "1");
  } catch {}
}

async function checkChannelsReady(): Promise<boolean> {
  const cfg = readConfig() ?? {};
  const channels = (cfg as Record<string, unknown>).channels as Record<string, unknown> | undefined;
  const tg = channels?.telegram as Record<string, unknown> | undefined;
  const hasBotToken = !!(tg?.botToken);

  // Persistent flag set on successful pairing (survives restarts).
  // Self-heal: if the flag is stale (set when telegram was configured,
  // but the config has since been wiped — e.g. by a v0.9.8 re-auth that
  // rewrote openclaw.json from scratch), clear it so the UI exposes the
  // "add bot token" step again. Without this, an existing deployment
  // that lost its telegram config is unrecoverable through the UI.
  try {
    if (fs.existsSync(CHANNELS_READY_FLAG)) {
      if (!hasBotToken) {
        console.log("[snapclaw] stale .channels-ready flag (no bot token in config); clearing");
        try { fs.unlinkSync(CHANNELS_READY_FLAG); } catch {}
        channelsReady = false;
      } else {
        channelsReady = true;
        return true;
      }
    }
  } catch {}

  // Real pairing signal #1: a device was approved. The pairing handshake
  // (user sends /start to the bot, bot responds with a code, user enters
  // the code in setup) ends with an approved device entry.
  try {
    const r = await runCmd("openclaw", ["devices", "list", "--json"], 10_000);
    if (r.code === 0) {
      const parsed = JSON.parse(r.output);
      const approved = (parsed.approved ?? parsed.devices ?? []) as unknown[];
      if (Array.isArray(approved) && approved.length > 0) {
        markChannelsReady();
        return true;
      }
    }
  } catch {}

  // Real pairing signal #2: an operator account is bound via
  // commands.ownerAllowFrom. Set during pairing when a Telegram user is
  // promoted to operator. Does NOT get populated just by writing a bot
  // token — so this is a trustworthy signal.
  const commands = (cfg as Record<string, unknown>).commands as Record<string, unknown> | undefined;
  const ownerAllowFrom = commands?.ownerAllowFrom;
  if (Array.isArray(ownerAllowFrom) && ownerAllowFrom.length > 0) {
    markChannelsReady();
    return true;
  }

  // NOTE: the previous heuristics (plugins.entries.<channel> exists,
  // channels.telegram has extra keys beyond botToken, `openclaw channels
  // list` mentions a channel name) were all false positives — they fire
  // as soon as a bot token is configured, before the user has ever
  // messaged the bot. They made the setup UI report "Telegram bot is
  // connected" while the user had received no pairing code, and the
  // false state then persisted via CHANNELS_READY_FLAG. Removed.
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

  // (Bonjour disable + telegram poll-stall live in gateway.ensureConfig()
  // so they apply on every boot, not just first-time onboarding.)

  // Allow Control UI connections without device pairing
  await runCmd("openclaw", [
    "config", "set", "--json", "gateway.controlUi.dangerouslyDisableDeviceAuth", "true",
  ]);
  await runCmd("openclaw", [
    "config", "set", "--json", "gateway.controlUi.allowInsecureAuth", "true",
  ]);

  // Clean up onboard boilerplate files
  try { fs.unlinkSync(path.join(WORKSPACE_DIR, "BOOTSTRAP.md")); } catch {}

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
  // Re-authentication vs first-time onboarding take different code paths.
  // `openclaw onboard` would rewrite openclaw.json from scratch — wiping
  // the Telegram bot token, pairing state, and anything else the user
  // has already configured. So when a config already exists, use the
  // narrower `models auth login --provider openai-codex` command, which
  // only refreshes the Codex OAuth profile and leaves the rest alone.
  // (This is exactly what OpenClaw's own "Model login expired" error
  // tells the user to run.)
  const isReauth = isConfigured();

  let args: string[];
  if (isReauth) {
    args = ["models", "auth", "login", "--provider", "openai-codex"];
    console.log("[codex] starting re-authentication (config preserved)");
  } else {
    // First-time onboarding: wipe any partial config so onboard doesn't
    // get blocked asking about existing values.
    try { fs.unlinkSync(configPath()); } catch {}
    args = [
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
    ];
    console.log("[codex] starting first-time onboarding");
  }

  const shell = pty.spawn("openclaw", args, {
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
  });

  if (!isReauth) {
    // First-time onboarding: poll for config-file appearance instead of
    // grepping PTY output for "Updated openclaw.json" — that line is
    // not a contract. onboard may also hang on a hooks prompt after
    // writing the config, so we kill the PTY ourselves once the file
    // exists.
    const configWatcher = setInterval(() => {
      if (session.status !== "waiting") {
        clearInterval(configWatcher);
        return;
      }
      if (isConfigured()) {
        clearInterval(configWatcher);
        console.log("[codex] config written, finishing session");
        session.status = "done";
        setTimeout(() => { try { shell.kill(); } catch {} }, 500);
      }
    }, 500);
  }

  shell.onExit(({ exitCode }) => {
    if (isReauth) {
      // Re-auth: completion is a clean PTY exit. Config already existed
      // throughout, so isConfigured() isn't a useful signal here.
      session.status = exitCode === 0 ? "done" : "error";
    } else {
      session.status = (exitCode === 0 || isConfigured()) ? "done" : "error";
    }
    console.log(`[codex] exited code=${exitCode} status=${session.status} mode=${isReauth ? "reauth" : "onboard"}`);
  });

  codexSession = session;

  // Auto-cleanup after 30 min. ChatGPT OAuth (sign-in + 2FA + approve +
  // copy redirect URL) regularly takes more than 5 minutes on first-time
  // setup; killing the PTY mid-flow leaves users with a confusing
  // "No active session" error when they paste the redirect.
  setTimeout(() => {
    if (codexSession === session) {
      try { shell.kill(); } catch {}
      codexSession = null;
    }
  }, 1_800_000);

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

    // Frontend CSS
    if (url === "/snapclaw/setup.css" && method === "GET") {
      return sendFile(res, path.join(publicDir, "setup.css"), "text/css");
    }

    // API: status
    if (url === "/snapclaw/api/status" && method === "GET") {
      if (!channelsReady) await checkChannelsReady();
      const cfg = readConfig();
      const channels = cfg?.channels as Record<string, unknown> | undefined;
      const tg = channels?.telegram as Record<string, unknown> | undefined;
      const botTokenSet = !!(tg?.botToken);
      // Extract model name from agents.defaults.model (string or object)
      const agents = cfg?.agents as Record<string, unknown> | undefined;
      const defaults = agents?.defaults as Record<string, unknown> | undefined;
      const rawModel = defaults?.model;
      let model: string | null = null;
      if (typeof rawModel === "string") {
        model = rawModel;
      } else if (rawModel && typeof rawModel === "object") {
        const m = rawModel as Record<string, unknown>;
        const pick = (v: unknown) => (typeof v === "string" ? v : null);
        model = pick(m.name) ?? pick(m.id) ?? pick(m.model) ?? pick(m.slug) ?? null;
      }
      // Check if auth credentials exist (not just config file)
      const auth = cfg?.auth as Record<string, unknown> | undefined;
      const profiles = auth?.profiles as Record<string, unknown> | undefined;
      const hasAuth = !!(profiles && Object.keys(profiles).length > 0);
      return sendJson(res, {
        ok: true,
        configured: isConfigured(),
        codexConnected: hasAuth,
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
      if (!codexSession?.pty) {
        return sendJson(res, {
          ok: false,
          error: "Codex onboarding session expired or not started. Click \"Start Codex OAuth\" to begin a new one.",
        }, 400);
      }

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
        // Token saved — but not yet paired. Don't set channelsReady here.
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

    // API: mark channels as ready (manual override). For users whose bot
    // is already paired via persistent config state from a previous
    // session — checkChannelsReady() can't always detect that, so the
    // UI gets stuck in "Waiting for pairing code..." while the bot is
    // actually fully functional. This endpoint just writes the flag.
    if (url === "/snapclaw/api/channels/mark-ready" && method === "POST") {
      markChannelsReady();
      return sendJson(res, { ok: true });
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
        markChannelsReady();
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

  // Pre-symlink ~/.openclaw and ~/.codex to the persistent volume BEFORE
  // any openclaw subprocess runs (codex onboard writes its OAuth tokens
  // under $HOME by default, and would otherwise lose them on every redeploy).
  ensurePersistentLinks();

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
