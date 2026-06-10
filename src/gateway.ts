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
import { ensurePersistentLinks, runCmd, sleep, deepSet } from "./utils.js";

let proc: ChildProcess | null = null;
let starting: Promise<void> | null = null;
// Set true only while stop()/restart() is intentionally tearing the gateway
// down, so the crash watchdog doesn't fight a deliberate shutdown.
let stopping = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveCrashes = 0;

export function isRunning(): boolean {
  return proc !== null && proc.exitCode === null;
}

// Auto-restart the gateway after an unexpected exit, with exponential backoff.
// Without this, a crash leaves the bot silently down (Telegram polling stops)
// until the next proxied HTTP request happens to call ensure().
function scheduleRestart(): void {
  if (restartTimer || starting || stopping) return;
  consecutiveCrashes++;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(consecutiveCrashes - 1, 5));
  console.warn(
    `[gateway] unexpected exit — auto-restart in ${delay}ms (crash #${consecutiveCrashes})`,
  );
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (isRunning() || stopping || !isConfigured()) return;
    // Route through ensure() so a concurrent proxied-request start is deduped
    // via the shared `starting` promise instead of double-spawning.
    ensure().catch((err) => {
      console.error("[gateway] auto-restart failed:", err);
      scheduleRestart();
    });
  }, delay);
}

async function waitReady(timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${GATEWAY_TARGET}/`, { method: "GET" });
      // A 4xx (e.g. 401 auth-required) still means the listener is up and
      // routing. Only a missing response or 5xx means "not ready yet".
      if (res.status > 0 && res.status < 500) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

async function ensureConfig(): Promise<void> {
  // Read the existing config up front so every SnapClaw-required setting can be
  // applied in ONE in-memory read-modify-write below, then written once. This
  // used to be ~15 separate `openclaw config set` subprocesses on every boot —
  // each a full CLI cold-start, which is slow on Railway's constrained CPU.
  // Bail (don't write) if the config is unreadable so we never clobber it.
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.warn(
      `[gateway] ensureConfig: config unreadable, skipping (${(err as Error).message})`,
    );
    return;
  }

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

  // --- Apply every SnapClaw-required setting in one in-memory pass ---
  // The comments explain *why* each value is forced; the values themselves are
  // the canonical JSON types OpenClaw expects (booleans/arrays/objects), which
  // also fixes a latent inconsistency where some of these were previously set
  // as the bare string "true" via a non-`--json` `config set`.

  deepSet(cfg, "gateway.mode", "local");
  deepSet(cfg, "gateway.controlUi.allowedOrigins", [...origins]);
  deepSet(cfg, "browser", browserConfig);

  // Use the `full` profile: unrestricted tool access. SnapClaw is a
  // single-operator personal agent, and the narrower profiles (coding,
  // messaging) each omit tools we need (coding lacks browser+message;
  // messaging lacks fs+runtime). Clear `allow` AND `alsoAllow` so leftover
  // values from prior configs don't override the profile — `tools.allow`
  // replaces the profile's list entirely (per OpenClaw docs), so a
  // lingering `["browser"]` would silently strip fs/exec/message tools.
  deepSet(cfg, "tools.profile", "full");
  deepSet(cfg, "tools.allow", []);
  deepSet(cfg, "tools.alsoAllow", []);

  // Trust loopback proxy so Railway-forwarded requests are treated as local.
  deepSet(cfg, "gateway.trustedProxies", ["127.0.0.1", "::1"]);

  // Railway terminates TLS at the edge and proxies over HTTP internally, so the
  // gateway must allow token auth over the loopback HTTP connection.
  deepSet(cfg, "gateway.controlUi.allowInsecureAuth", true);
  // Disable device pairing so the Control UI connects without manual approval.
  deepSet(cfg, "gateway.controlUi.dangerouslyDisableDeviceAuth", true);

  // Sync gateway tokens.
  deepSet(cfg, "gateway.auth.mode", "token");
  deepSet(cfg, "gateway.auth.token", GATEWAY_TOKEN);
  deepSet(cfg, "gateway.remote.token", GATEWAY_TOKEN);

  // plugins.allow MUST stay empty. v0.9.2 set this to `["codex"]` to silence
  // a "plugins.allow is empty; non-bundled plugins may auto-load" warning,
  // but OpenClaw treats plugins.allow as an exclusive allowlist — setting it
  // to `["codex"]` blocked every bundled plugin including telegram, browser,
  // memory-core, etc. The bot stopped polling Telegram entirely, so messages
  // to the bot silently disappeared. Reset to [] on every boot so existing
  // deployments that picked up the bad config self-heal on the next restart.
  deepSet(cfg, "plugins.allow", []);

  // Disable Bonjour: Railway has no LAN to advertise to, and the bundled
  // Bonjour plugin (default-enabled in OpenClaw 2026.4.24+) crashes the
  // gateway with "CIAO ANNOUNCEMENT CANCELLED" unhandled rejections when
  // mDNS multicast fails. Must run on every boot, not just onboarding,
  // so existing deploys pick up the disable on upgrade.
  deepSet(cfg, "plugins.entries.bonjour.enabled", false);

  const tgPollStallMs = process.env.OPENCLAW_TELEGRAM_POLL_STALL_MS;
  if (tgPollStallMs && /^\d+$/.test(tgPollStallMs)) {
    deepSet(cfg, "channels.telegram.pollingStallThresholdMs", parseInt(tgPollStallMs, 10));
  }

  // Clean up onboard boilerplate (previously done in applyPostSetupConfig).
  try {
    fs.unlinkSync(`${WORKSPACE_DIR}/BOOTSTRAP.md`);
  } catch {}

  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
  } catch (err) {
    console.error(
      `[gateway] ensureConfig: failed to write config (${(err as Error).message})`,
    );
  }
}

function clearStaleBrowserLocks(): void {
  // OpenClaw stores Chromium user-data dirs at:
  //   $OPENCLAW_STATE_DIR/browser/<profile>/user-data/Singleton{Lock,Cookie,Socket}
  // On Railway every redeploy is a fresh container with a new PID space, but
  // the persistent volume keeps old Singleton* files pointing at PIDs that
  // no longer exist. Chromium then sits in retry/timeout limbo on first
  // launch. OpenClaw 2026.4.24 has stale-lock recovery, but it kicks in
  // only after the first attempt times out — past the agent's tool budget.
  // Clear them here so the first launch is clean.
  const browserRoot = `${STATE_DIR}/browser`;
  let cleared = 0;
  try {
    for (const profile of fs.readdirSync(browserRoot)) {
      const userDataDir = `${browserRoot}/${profile}/user-data`;
      for (const basename of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        const p = `${userDataDir}/${basename}`;
        try {
          fs.rmSync(p, { force: true });
          if (fs.existsSync(p) === false) cleared++;
        } catch {}
      }
    }
  } catch {
    // browserRoot doesn't exist yet (fresh deploy) — nothing to clear
    return;
  }
  if (cleared > 0) console.log(`[gateway] cleared ${cleared} stale Chromium Singleton lock(s)`);
}

// Re-own the plugin tree to root via the narrow NOPASSWD sudo helper installed
// in the Dockerfile (see scripts/own-plugins.sh). The gateway runs as `node`
// and can't chown to root directly. Best-effort: a failure (e.g. helper absent
// in local dev) is logged, not fatal.
async function reownPlugins(): Promise<void> {
  try {
    const r = await runCmd("sudo", ["-n", "/usr/local/bin/snapclaw-own-plugins"]);
    if (r.code !== 0) {
      console.warn(`[gateway] plugin re-own exited ${r.code}: ${r.output.trim()}`);
    }
  } catch (err) {
    console.warn("[gateway] plugin re-own failed:", err);
  }
}

// Single guarded entry point: concurrent callers (a proxied request via
// ensure(), a restart(), the crash watchdog) all share one in-flight start
// instead of double-spawning the gateway.
export async function start(): Promise<void> {
  if (isRunning()) return;
  if (starting) return starting;
  starting = startInternal().finally(() => {
    starting = null;
  });
  return starting;
}

async function startInternal(): Promise<void> {
  if (isRunning()) return;
  if (!isConfigured()) throw new Error("Not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  ensurePersistentLinks();
  clearStaleBrowserLocks();

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
  // Intentionally do NOT run `openclaw doctor --fix` on every boot. It's an
  // unbounded auto-repair pass: OpenClaw 2026.5.5 doctor rewrote valid
  // `openai-codex/*` OAuth routes to `openai/*` (reverted in 5.6), and
  // similar destructive migrations are a recurring risk. Run it manually
  // (`openclaw doctor --fix`) when something is actually broken. The
  // targeted config writes in ensureConfig() below cover SnapClaw's needs.

  await ensureConfig();

  // Re-own the plugin tree to root before the gateway loads plugins. OpenClaw
  // 2026.5.27+ blocks plugins not owned by root ("suspicious ownership"), but
  // onboarding installs the codex plugin as the unprivileged `node` user. The
  // entrypoint handles this at container boot; this covers the mid-session
  // case (fresh onboarding) so codex loads without a restart. Best-effort via
  // a narrow NOPASSWD sudo helper — never blocks gateway start.
  await reownPlugins();

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

  // Capture this spawn so a late exit event from an old process can't null out
  // a newer one that a fast restart has already put in place.
  const self = proc;
  proc.on("exit", (code, signal) => {
    console.log(`[gateway] exited code=${code} signal=${signal}`);
    if (proc === self) proc = null;
    if (stopping || !isConfigured()) return;
    scheduleRestart();
  });

  proc.on("error", (err) => {
    console.error(`[gateway] error: ${err}`);
    if (proc === self) proc = null;
  });

  const ready = await waitReady();
  if (ready) {
    consecutiveCrashes = 0; // healthy boot resets the backoff
  } else {
    console.warn("[gateway] did not become ready in time");
  }

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
  // Mark intentional shutdown so the exit handler doesn't schedule a restart,
  // and cancel any restart the watchdog already queued.
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (!proc) {
    stopping = false;
    return;
  }
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
  stopping = false;
}

export async function restart(): Promise<void> {
  await stop();
  await start();
}

export async function ensure(): Promise<void> {
  if (isRunning()) return;
  if (!isConfigured()) return;
  return start();
}
