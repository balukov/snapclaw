import { spawn, type ChildProcess } from "node:child_process";
import { WORKSPACE_DIR } from "./config.js";
import { runCmd } from "./utils.js";

export type SyncState = "running" | "configured" | "not-configured";

const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
const STABLE_UPTIME_MS = 10 * 60_000;

export function nextBackoffMs(attempt: number): number {
  const i = Math.max(0, Math.min(attempt, BACKOFF_MS.length - 1));
  return BACKOFF_MS[i];
}

let proc: ChildProcess | null = null;
let configured = false;
let stopping = false;
let attempt = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

export function isRunning(): boolean {
  return proc !== null && proc.exitCode === null;
}

export function state(): SyncState {
  if (isRunning()) return "running";
  return configured ? "configured" : "not-configured";
}

export async function isConfigured(): Promise<boolean> {
  const r = await runCmd("ob", ["sync-status", "--path", WORKSPACE_DIR, "--json"], 20_000);
  configured = r.code === 0;
  return configured;
}

export async function ensure(): Promise<SyncState> {
  if (isRunning()) return "running";
  if (!(await isConfigured())) return "not-configured";
  start();
  return state();
}

function scheduleRestart(startedAt: number): void {
  if (stopping || restartTimer) return;
  if (Date.now() - startedAt > STABLE_UPTIME_MS) attempt = 0;
  const delay = nextBackoffMs(attempt);
  attempt++;
  console.warn(`[sync] restart in ${delay}ms (attempt #${attempt})`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    start();
  }, delay);
}

function start(): void {
  if (isRunning() || stopping) return;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const startedAt = Date.now();
  const child = spawn("ob", ["sync", "--continuous", "--path", WORKSPACE_DIR], {
    stdio: "inherit",
  });
  proc = child;
  console.log(`[sync] ob sync --continuous started for ${WORKSPACE_DIR}`);

  child.on("exit", (code, signal) => {
    console.log(`[sync] exited code=${code} signal=${signal}`);
    if (proc === child) proc = null;
    if (stopping) return;
    scheduleRestart(startedAt);
  });

  child.on("error", (err) => {
    console.error(`[sync] failed to start ob: ${err.message}`);
    if (proc === child) proc = null;
    scheduleRestart(startedAt);
  });
}

export async function stop(): Promise<void> {
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const p = proc;
  if (!p) {
    stopping = false;
    return;
  }
  proc = null;
  p.kill("SIGTERM");
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
