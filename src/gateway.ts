import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import {
  STATE_DIR,
  WORKSPACE_DIR,
  INTERNAL_PORT,
  GATEWAY_TOKEN,
  GATEWAY_TARGET,
  isConfigured,
  configPath,
} from "./config.js";
import { runCmd, sleep } from "./utils.js";

let proc: ChildProcess | null = null;
let starting: Promise<void> | null = null;

export function isRunning(): boolean {
  return proc !== null && proc.exitCode === null;
}

async function waitReady(timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${GATEWAY_TARGET}/`, { method: "GET" });
      if (res) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

async function ensureConfig(): Promise<void> {
  // Always ensure gateway.mode=local
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (cfg?.gateway?.mode !== "local") {
      await runCmd("openclaw", ["config", "set", "gateway.mode", "local"]);
    }
  } catch {}

  // Ensure allowedOrigins includes Railway domain
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (domain) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
      const origins: string[] =
        cfg?.gateway?.controlUi?.allowedOrigins ?? [];
      const needed = `https://${domain}`;
      if (!origins.includes(needed)) {
        await runCmd("openclaw", [
          "config",
          "set",
          "--json",
          "gateway.controlUi.allowedOrigins",
          JSON.stringify([needed, "http://localhost:3000"]),
        ]);
      }
    } catch {}
  }

  // Auto-detect Playwright Chromium and configure browser plugin
  try {
    const pwBase = process.env.PLAYWRIGHT_BROWSERS_PATH || "/home/node/.cache/ms-playwright";
    const dirs = fs.readdirSync(pwBase).filter(d => d.startsWith("chromium-"));
    if (dirs.length > 0) {
      const chromePath = `${pwBase}/${dirs[0]}/chrome-linux64/chrome`;
      if (fs.existsSync(chromePath)) {
        await runCmd("openclaw", [
          "config", "set", "--json", "browser",
          JSON.stringify({
            enabled: true,
            executablePath: chromePath,
            headless: true,
            noSandbox: true,
            defaultProfile: "openclaw",
          }),
        ]);
      }
    }
  } catch {}

  // Trust loopback proxy so Railway-forwarded requests are treated as local
  await runCmd("openclaw", [
    "config",
    "set",
    "--json",
    "gateway.trustedProxies",
    JSON.stringify(["127.0.0.1", "::1"]),
  ]);

  // Sync gateway tokens
  await runCmd("openclaw", ["config", "set", "gateway.auth.mode", "token"]);
  await runCmd("openclaw", [
    "config",
    "set",
    "gateway.auth.token",
    GATEWAY_TOKEN,
  ]);
  await runCmd("openclaw", [
    "config",
    "set",
    "gateway.remote.token",
    GATEWAY_TOKEN,
  ]);
}

export async function start(): Promise<void> {
  if (isRunning()) return;
  if (!isConfigured()) throw new Error("Not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  await ensureConfig();

  proc = spawn(
    "openclaw",
    [
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(INTERNAL_PORT),
      "--auth",
      "token",
      "--token",
      GATEWAY_TOKEN,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    },
  );

  proc.on("exit", (code, signal) => {
    console.log(`[gateway] exited code=${code} signal=${signal}`);
    proc = null;
  });

  proc.on("error", (err) => {
    console.error(`[gateway] error: ${err}`);
    proc = null;
  });

  const ready = await waitReady();
  if (!ready) console.warn("[gateway] did not become ready in time");
}

export async function stop(): Promise<void> {
  if (!proc) return;
  proc.kill("SIGTERM");
  await sleep(1000);
  proc = null;
}

export async function restart(): Promise<void> {
  await stop();
  await start();
}

export async function ensure(): Promise<void> {
  if (isRunning()) return;
  if (!isConfigured()) return;
  if (starting) return starting;

  starting = start().finally(() => {
    starting = null;
  });
  return starting;
}
