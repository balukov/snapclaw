import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import httpProxy from "http-proxy";
import { WebSocketServer, WebSocket } from "ws";
import pty from "node-pty";

import {
  PORT,
  SETUP_PASSWORD,
  SESSION_SECRET,
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
import * as sync from "./sync.js";
import { ensurePersistentLinks, runCmd, redactSecrets, sleep } from "./utils.js";
import { countAuthProfiles, dashboardFragment } from "./upgrade.js";

// --- Auth ---

const terminalTokens = new Map<string, number>();

// Constant-time comparison so password/token checks don't leak via response
// timing. timingSafeEqual requires equal-length buffers, so an unavoidable
// length check comes first.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function makeSessionToken(): string {
  const hmac = crypto.createHmac("sha256", SESSION_SECRET);
  hmac.update(SETUP_PASSWORD);
  return hmac.digest("hex");
}

// --- Login brute-force protection ---
// The whole security model rests on SETUP_PASSWORD (OpenClaw device auth is
// delegated away) and the panel sits on a public domain — so throttle guesses
// per client IP.
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const loginAttempts = new Map<
  string,
  { fails: number; first: number; lockedUntil: number }
>();

function clientIp(req: http.IncomingMessage): string {
  const xff = (req.headers["x-forwarded-for"] as string | undefined)
    ?.split(",")[0]
    ?.trim();
  return xff || req.socket.remoteAddress || "unknown";
}

// Remaining lockout in ms (0 if not locked).
function lockoutRemaining(ip: string): number {
  const e = loginAttempts.get(ip);
  if (!e) return 0;
  return e.lockedUntil > Date.now() ? e.lockedUntil - Date.now() : 0;
}

function recordLoginFail(ip: string): void {
  const now = Date.now();
  const e = loginAttempts.get(ip) ?? { fails: 0, first: now, lockedUntil: 0 };
  if (now - e.first > LOGIN_WINDOW_MS) {
    e.fails = 0;
    e.first = now;
    e.lockedUntil = 0;
  }
  e.fails++;
  if (e.fails >= LOGIN_MAX_FAILS) e.lockedUntil = now + LOGIN_WINDOW_MS;
  loginAttempts.set(ip, e);
}

// Verify a submitted password (constant-time) with per-IP lockout. Returns
// false while locked out, even when the password is correct.
function verifyPassword(ip: string, password: string): boolean {
  if (lockoutRemaining(ip) > 0) return false;
  if (safeEqual(password, SETUP_PASSWORD)) {
    loginAttempts.delete(ip);
    return true;
  }
  recordLoginFail(ip);
  return false;
}

function checkAuth(req: http.IncomingMessage): boolean {
  // Check session cookie
  const cookies = req.headers.cookie ?? "";
  const match = cookies.match(/snapclaw_session=([a-f0-9]+)/);
  if (match && safeEqual(match[1], makeSessionToken())) return true;
  // Also accept basic auth for API clients (rate-limited like the login form)
  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    return verifyPassword(clientIp(req), password);
  }
  return false;
}

// Browsers attach cookies to cross-site WebSocket handshakes and CORS does not
// apply, so a cookie-gated upgrade is hijackable unless the origin is checked.
// A missing Origin means a non-browser client, which cross-site hijacking
// cannot reach.
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Replace any client credential with the gateway's own token. checkAuth() may
// have accepted Basic, whose header carries SETUP_PASSWORD — forwarding it
// downstream would leak the admin password into the gateway process.
function setGatewayAuth(req: http.IncomingMessage): void {
  if (GATEWAY_TOKEN) {
    req.headers.authorization = `Bearer ${GATEWAY_TOKEN}`;
  } else {
    delete req.headers.authorization;
  }
}

// Set before any writeHead, so one call covers every response site as well as
// proxied ones — http-proxy only overwrites names the upstream itself sends.
function setSecurityHeaders(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");

  // CSP covers SnapClaw's own pages only. OpenClaw Control is a third-party SPA
  // whose asset requirements move with upstream releases, so policing it here
  // would break it on some future version.
  const url = req.url ?? "/";
  if (!url.startsWith("/snapclaw") && url !== "/healthz") return;

  // Name the WebSocket origin explicitly: 'self' ought to cover same-origin wss
  // under CSP3, but support has been uneven and getting it wrong kills the
  // terminal silently.
  const host = req.headers.host ?? "";
  const wsSrc = /^[A-Za-z0-9.\-:]+$/.test(host) ? ` wss://${host}` : "";

  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'self' https://cdn.jsdelivr.net",
      // 'unsafe-inline' is required: xterm.js sizes and themes the terminal by
      // assigning to element.style at runtime, and CSSOM writes are governed by
      // style-src with no hash or nonce escape hatch. Without it the terminal
      // renders unusable. script-src stays strict, which is the directive that
      // actually stands between an injected script and the shell.
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src 'self'",
      `connect-src 'self'${wsSrc}`,
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
}

const publicDir = new URL("../public", import.meta.url).pathname;

const SNAPCLAW_VERSION = (JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string }).version;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function sendLoginPage(res: http.ServerResponse, error = ""): void {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  let html: string;
  try {
    html = fs
      .readFileSync(path.join(publicDir, "login.html"), "utf8")
      .replace("<!--ERROR-->", errorHtml);
  } catch {
    html = `<!doctype html><meta charset="utf-8"><title>SnapClaw</title>
<form method="POST" action="/snapclaw/login">${errorHtml}
<input type="password" name="password" autofocus><button>Log in</button></form>`;
  }
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
let authCache: { value: boolean; until: number } | null = null;

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
  const hasBotToken = !!readConfig()?.channels?.telegram?.botToken;
  channelsReady = hasBotToken && fs.existsSync(CHANNELS_READY_FLAG);
  if (hasBotToken === false && fs.existsSync(CHANNELS_READY_FLAG)) {
    try { fs.unlinkSync(CHANNELS_READY_FLAG); } catch {}
  }
  return channelsReady;
}

// --- Auto-configure helpers ---

// NOTE: there is no separate post-setup config pass. Every onboard path below
// is followed by a gateway start/restart, and gateway.ensureConfig() applies
// all SnapClaw-required settings there (on every boot), so doing it twice was
// redundant. gateway.bind/port come from the `onboard` flags + the gateway-run
// flags; the rest (auth tokens, trustedProxies, controlUi flags, allowedOrigins,
// BOOTSTRAP.md cleanup) all live in ensureConfig().

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
    console.log("[snapclaw] onboarding complete (config applied on gateway start)");
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


function startCodexSession(): CodexSession {
  // Re-authentication vs first-time onboarding take different code paths.
  // `openclaw onboard` would rewrite openclaw.json from scratch — wiping
  // the Telegram bot token, pairing state, and anything else the user
  // has already configured. So when a config already exists, use the
  // narrower `models auth login --provider openai` command, which
  // only refreshes the Codex OAuth profile and leaves the rest alone.
  // (This is exactly what OpenClaw's own "Model login expired" error
  // tells the user to run.)
  const isReauth = isConfigured();

  let args: string[];
  if (isReauth) {
    args = ["models", "auth", "login", "--provider", "openai"];
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
      "--auth-choice", "openai",
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
    cwd: STATE_DIR,
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
    authCache = null;
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

// --- Route handlers ---

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void>;

// Health check — no auth. Stays 200 while the web server is up: the
// in-process gateway watchdog handles recovery, so we don't want Docker/
// Railway killing the whole container over a transient gateway blip. The
// body still reports gateway liveness honestly for monitors and the UI.
const handleHealthz: Handler = (_req, res) => {
  const gw = !isConfigured()
    ? "unconfigured"
    : gateway.isRunning()
      ? "running"
      : "down";
  sendJson(res, { ok: true, gateway: gw });
};

const handleLogin: Handler = async (req, res) => {
  const ip = clientIp(req);
  const locked = lockoutRemaining(ip);
  if (locked > 0) {
    const mins = Math.ceil(locked / 60_000);
    return sendLoginPage(res, `Too many attempts. Try again in ${mins} min.`);
  }
  const body = await readBody(req);
  const params = new URLSearchParams(body.toString("utf8"));
  const password = params.get("password") ?? "";
  if (verifyPassword(ip, password)) {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)
      ?.split(",")[0]
      ?.trim();
    const secure = proto === "https" ? "; Secure" : "";
    res.writeHead(302, {
      Location: "/snapclaw",
      "Set-Cookie": `snapclaw_session=${makeSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`,
    });
    res.end();
    return;
  }
  const stillLocked = lockoutRemaining(ip);
  if (stillLocked > 0) {
    const mins = Math.ceil(stillLocked / 60_000);
    return sendLoginPage(res, `Too many attempts. Try again in ${mins} min.`);
  }
  return sendLoginPage(res, "Wrong password");
};

async function codexConnected(): Promise<boolean> {
  if (authCache && Date.now() < authCache.until) return authCache.value;
  const r = await runCmd("openclaw", ["models", "auth", "list", "--provider", "openai", "--json"], 15_000);
  const value = r.code === 0 && countAuthProfiles(r.output) > 0;
  authCache = { value, until: Date.now() + (value ? 60_000 : 5_000) };
  return value;
}

async function restartGateway(): Promise<void> {
  authCache = null;
  await gateway.restart();
}

const handleStatus: Handler = async (_req, res) => {
  if (!channelsReady) await checkChannelsReady();
  const cfg = readConfig() ?? {};
  const botTokenSet = !!cfg.channels?.telegram?.botToken;
  const rawModel = cfg.agents?.defaults?.model;
  const model = typeof rawModel === "string" ? rawModel : rawModel?.primary ?? null;
  const hasAuth = isConfigured() && (await codexConnected());
  sendJson(res, {
    ok: true,
    configured: isConfigured(),
    codexConnected: hasAuth,
    channelsReady,
    botTokenSet,
    model,
    snapclawVersion: SNAPCLAW_VERSION,
    openclawVersion: cachedVersion,
    gatewayTarget: GATEWAY_TARGET,
    gatewayRunning: gateway.isRunning(),
    obsidianSync: sync.state(),
  });
};

const handleCodexStart: Handler = async (_req, res) => {
  authCache = null;
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
    sendJson(res, { ok: true, oauthUrl: session.oauthUrl, status: session.status });
  } catch (err) {
    sendJson(res, { ok: false, error: (err as Error).message ?? String(err) }, 500);
  }
};

const handleCodexCallback: Handler = async (req, res) => {
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
    // restartGateway() -> ensureConfig() applies all required config.
    await restartGateway();
  }
  const result = { ok, status: codexSession.status };
  codexSession = null;
  sendJson(res, result);
};

const handleTelegramAdd: Handler = async (req, res) => {
  const body = await readJson(req);
  const token = String(body.token ?? "").trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    return sendJson(res, { ok: false, error: "Invalid bot token format" }, 400);
  }
  const r = await runCmd("openclaw", [
    "channels", "add", "--channel", "telegram", "--token", token,
  ]);
  if (r.code === 0) {
    // Token saved — but not yet paired. Don't set channelsReady here.
    await restartGateway();
  }
  sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
};

const handleTerminalToken: Handler = (_req, res) => {
  const token = crypto.randomBytes(24).toString("hex");
  terminalTokens.set(token, Date.now() + 60_000);
  // Clean expired
  for (const [k, exp] of terminalTokens) {
    if (Date.now() > exp) terminalTokens.delete(k);
  }
  sendJson(res, { token });
};

const handleConsoleRun: Handler = async (req, res) => {
  const body = await readJson(req);
  if (body.cmd !== "gateway.restart") {
    return sendJson(res, { ok: false, error: "Unknown command" }, 400);
  }
  await restartGateway();
  sendJson(res, { ok: true, output: "Gateway restarted." });
};

const handleSyncEnsure: Handler = async (_req, res) => {
  const state = await sync.ensure();
  sendJson(res, { ok: true, state });
};

const handlePairingApprove: Handler = async (req, res) => {
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
  sendJson(res, { ok: r.code === 0, output: redactSecrets(r.output) });
};

// --- Route tables ---
// Key: "<METHOD> <exact path>". Public routes need no auth; setup routes sit
// behind checkAuth(). The login POST is dispatched before the auth gate.

const handleDashboard: Handler = async (_req, res) => {
  try {
    await gateway.ensure();
  } catch {}
  const r = await runCmd("openclaw", ["dashboard", "--json", "--no-open"], 20_000);
  const fragment = r.code === 0 ? dashboardFragment(r.output) : null;
  if (!fragment) {
    return sendJson(
      res,
      { ok: false, error: "Could not mint a Control UI link", output: redactSecrets(r.output) },
      502,
    );
  }
  res.writeHead(302, { Location: `/${fragment}`, "Cache-Control": "no-store" });
  res.end();
};

const staticFile = (name: string, type: string): Handler => (_req, res) =>
  sendFile(res, path.join(publicDir, name), type);

const publicRoutes: Record<string, Handler> = {
  "GET /healthz": handleHealthz,
  "GET /snapclaw-icon.png": staticFile("snapclaw-icon.png", "image/png"),
  // The login page is served to unauthenticated visitors, so its stylesheet
  // has to be reachable without a session or the page renders unstyled.
  "GET /snapclaw/login.css": staticFile("login.css", "text/css"),
};

const setupRoutes: Record<string, Handler> = {
  "GET /snapclaw": staticFile("setup.html", "text/html"),
  "GET /snapclaw/setup.js": staticFile("setup.js", "application/javascript"),
  "GET /snapclaw/setup.css": staticFile("setup.css", "text/css"),
  "GET /snapclaw/api/status": handleStatus,
  "GET /snapclaw/api/dashboard": handleDashboard,
  "POST /snapclaw/api/codex/start": handleCodexStart,
  "POST /snapclaw/api/codex/callback": handleCodexCallback,
  "POST /snapclaw/api/telegram/add": handleTelegramAdd,
  "GET /snapclaw/api/terminal-token": handleTerminalToken,
  "POST /snapclaw/api/console/run": handleConsoleRun,
  "POST /snapclaw/api/sync/ensure": handleSyncEnsure,
  "POST /snapclaw/api/pairing/approve": handlePairingApprove,
};

// --- Request dispatch ---

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const key = `${method} ${url}`;

  const pub = publicRoutes[key];
  if (pub) return pub(req, res);

  // --- Setup routes (require auth) ---
  if (url.startsWith("/snapclaw")) {
    // Login form POST — the one /snapclaw route allowed through unauthenticated
    if (key === "POST /snapclaw/login") return handleLogin(req, res);

    // Show login page if not authenticated
    if (!checkAuth(req)) {
      return sendLoginPage(res);
    }

    const handler = setupRoutes[key];
    if (handler) return handler(req, res);

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

  // Everything proxied to the gateway requires the setup session. Without this
  // the token injection below hands an admin credential to any anonymous
  // caller, exposing OpenClaw Control on the public domain.
  if (!checkAuth(req)) {
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

  setGatewayAuth(req);

  proxy.web(req, res, { target: GATEWAY_TARGET });
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  try {
    setSecurityHeaders(req, res);
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
  // An upgrade cannot carry a redirect, so refusals close the socket.
  if (!sameOrigin(req) || !checkAuth(req)) {
    socket.destroy();
    return;
  }
  setGatewayAuth(req);
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

// Start
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`[snapclaw] version: ${SNAPCLAW_VERSION}`);
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

  try {
    console.log(`[snapclaw] obsidian sync: ${await sync.ensure()}`);
  } catch (err) {
    console.error("[snapclaw] obsidian sync check failed:", err);
  }
});

process.on("SIGTERM", async () => {
  console.log("[snapclaw] SIGTERM received, shutting down...");
  server.close();
  await Promise.all([gateway.stop(), sync.stop()]);
  process.exit(0);
});
