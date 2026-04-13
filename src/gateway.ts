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

  // Collect all known origins for the Control UI
  const origins = new Set(["http://localhost:3000"]);
  for (const envVar of [
    "RAILWAY_PUBLIC_DOMAIN",
    "RAILWAY_PRIVATE_DOMAIN",
    "RAILWAY_STATIC_URL",
    "PUBLIC_DOMAIN",
  ]) {
    const val = process.env[envVar]?.trim();
    if (val) {
      // Handle both "domain.com" and "https://domain.com" formats
      origins.add(val.startsWith("http") ? val : `https://${val}`);
    }
  }
  await runCmd("openclaw", [
    "config",
    "set",
    "--json",
    "gateway.controlUi.allowedOrigins",
    JSON.stringify([...origins]),
  ]);

  // Enable browser plugin — OpenClaw auto-detects system chromium
  await runCmd("openclaw", [
    "config", "set", "--json", "browser",
    JSON.stringify({
      enabled: true,
      headless: true,
      noSandbox: true,
      defaultProfile: "openclaw",
      extraArgs: [
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    }),
  ]);

  // Trust loopback proxy so Railway-forwarded requests are treated as local
  await runCmd("openclaw", [
    "config",
    "set",
    "--json",
    "gateway.trustedProxies",
    JSON.stringify(["127.0.0.1", "::1"]),
  ]);

  // Railway terminates TLS at the edge and proxies over HTTP internally.
  // The gateway must allow token auth over the loopback HTTP connection.
  await runCmd("openclaw", [
    "config",
    "set",
    "gateway.controlUi.allowInsecureAuth",
    "true",
  ]);

  // Disable device pairing so Control UI connects without manual approval
  await runCmd("openclaw", [
    "config",
    "set",
    "gateway.controlUi.dangerouslyDisableDeviceAuth",
    "true",
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

  // Stop any leftover gateway process before starting
  await runCmd("openclaw", ["gateway", "stop"]);

  // Auto-fix config issues (e.g. plugin schema changes across openclaw versions)
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const plugins = cfg?.plugins?.entries;
    if (plugins) {
      let modified = false;
      // Fix memory-lancedb missing required 'embedding' property
      if (plugins["memory-lancedb"]) {
        const lancedb = plugins["memory-lancedb"] as Record<string, unknown>;
        const lancedbConfig = (lancedb.config ?? {}) as Record<string, unknown>;
        if (!lancedbConfig.embedding) {
          console.log("[gateway] removing memory-lancedb plugin (missing required embedding config)");
          delete plugins["memory-lancedb"];
          modified = true;
        }
      }
      if (modified) {
        fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
        console.log("[gateway] config repaired");
      }
    }
  } catch (err) {
    console.warn("[gateway] config auto-fix failed:", err);
  }
  await runCmd("openclaw", ["doctor", "--fix"]);

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
        // Ensure gateway can find globally installed plugin deps (grammy, etc.)
        NODE_PATH: [
          process.env.NODE_PATH,
          "/usr/local/lib/node_modules",
          "/usr/lib/node_modules",
        ].filter(Boolean).join(":"),
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
  const p = proc;
  proc = null;
  p.kill("SIGTERM");
  // Wait for the gateway (and its Chrome children) to exit gracefully
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      p.kill("SIGKILL");
      resolve();
    }, 10_000);
    p.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
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
