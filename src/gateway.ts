import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

  // Enable browser plugin with Playwright's bundled Chromium.
  // Scan PLAYWRIGHT_BROWSERS_PATH for the installed Chromium directory.
  // Playwright >=1.5x ships full chrome under chromium-<rev>/chrome-linux64/,
  // older revs use chrome-linux/, and a parallel headless-shell distribution
  // lives under chromium_headless_shell-<rev>/. Try in that order.
  const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || "/home/node/.cache/ms-playwright";
  let chromiumPath: string | undefined;
  let chromiumScanLog: string;
  try {
    const entries = fs.readdirSync(browsersDir);
    const chromiumDirs = entries.filter((d) => d.startsWith("chromium-") || d.startsWith("chromium_headless_shell-"));
    chromiumScanLog = `${browsersDir} entries=${JSON.stringify(entries)}`;
    for (const dir of chromiumDirs) {
      for (const [sub, bin] of [
        ["chrome-linux64", "chrome"],
        ["chrome-linux", "chrome"],
        ["chrome-linux", "headless_shell"],
      ] as const) {
        const candidate = `${browsersDir}/${dir}/${sub}/${bin}`;
        if (fs.existsSync(candidate)) { chromiumPath = candidate; break; }
      }
      if (chromiumPath) break;
    }
  } catch (err) {
    chromiumScanLog = `${browsersDir} readdir failed: ${(err as Error).message}`;
  }
  console.log(`[gateway] chromium scan: ${chromiumScanLog}`);
  if (chromiumPath) {
    // Verify the binary is actually executable. If --version exits non-zero,
    // the launch will fail later with no explanation; surface it now.
    const probe = spawnSync(chromiumPath, ["--version", "--no-sandbox"], {
      timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.status === 0) {
      console.log(`[gateway] chromium ok: ${chromiumPath} (${probe.stdout.toString().trim()})`);
    } else {
      console.error(
        `[gateway] chromium probe FAILED: ${chromiumPath} status=${probe.status} signal=${probe.signal}\n` +
        `  stderr: ${probe.stderr.toString().trim()}\n` +
        `  stdout: ${probe.stdout.toString().trim()}`,
      );
    }
  } else {
    console.error(`[gateway] no Chromium binary found under ${browsersDir} — browser tool will fail`);
  }

  const browserConfig: Record<string, unknown> = {
    enabled: true,
    headless: true,
    noSandbox: true,
    defaultProfile: "openclaw",
    snapshotDefaults: { mode: "efficient" },
    // OpenClaw 2026.4.24+ lazy-launches Chromium on first browser tool use.
    // Defaults (15s launch + 8s CDP-ready) are tight on Railway's slow-IO
    // volume mount and constrained CPU; bump generously so cold first-run
    // doesn't surface as "Timeout. Restart the OpenClaw gateway".
    localLaunchTimeoutMs: 90000,
    localCdpReadyTimeoutMs: 30000,
    extraArgs: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-setuid-sandbox",
      "--no-zygote",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
    ],
  };
  if (chromiumPath) browserConfig.executablePath = chromiumPath;

  await runCmd("openclaw", [
    "config", "set", "--json", "browser",
    JSON.stringify(browserConfig),
  ]);

  // Use the `full` profile: unrestricted tool access. SnapClaw is a
  // single-operator personal agent, and the narrower profiles (coding,
  // messaging) each omit tools we need (coding lacks browser+message;
  // messaging lacks fs+runtime). Clear alsoAllow so it doesn't linger
  // from previous configs.
  await runCmd("openclaw", ["config", "set", "tools.profile", "full"]);
  await runCmd("openclaw", [
    "config", "set", "--json", "tools.alsoAllow", JSON.stringify([]),
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

  // Disable Bonjour: Railway has no LAN to advertise to, and the bundled
  // Bonjour plugin (default-enabled in OpenClaw 2026.4.24+) crashes the
  // gateway with "CIAO ANNOUNCEMENT CANCELLED" unhandled rejections when
  // mDNS multicast fails. Must run on every boot, not just onboarding,
  // so existing deploys pick up the disable on upgrade.
  await runCmd("openclaw", [
    "config", "set", "--json", "plugins.entries.bonjour.enabled", "false",
  ]);

  const tgPollStallMs = process.env.OPENCLAW_TELEGRAM_POLL_STALL_MS;
  if (tgPollStallMs && /^\d+$/.test(tgPollStallMs)) {
    await runCmd("openclaw", [
      "config", "set", "--json", "channels.telegram.pollingStallThresholdMs", tgPollStallMs,
    ]);
  }
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

  // Run browser doctor in the background so the actual launch failure (if any)
  // surfaces in Railway logs instead of being relayed through the agent as a
  // generic "Restart the OpenClaw gateway" timeout. Don't block startup.
  void (async () => {
    try {
      const r = await runCmd(
        "openclaw",
        ["browser", "--browser-profile", "openclaw", "doctor"],
        120_000,
      );
      const out = r.output.trim();
      if (r.code === 0) {
        console.log(`[gateway] browser doctor ok:\n${out}`);
      } else {
        console.error(`[gateway] browser doctor FAILED (code=${r.code}):\n${out}`);
      }
    } catch (err) {
      console.error(`[gateway] browser doctor errored: ${(err as Error).message}`);
    }
  })();
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
