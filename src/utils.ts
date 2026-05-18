import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR, WORKSPACE_DIR } from "./config.js";

// Make sure $HOME-resolved openclaw/codex paths land on the persistent
// volume. Several OpenClaw components (memory-core, codex auth) fall
// back to `$HOME/.openclaw` or `$HOME/.codex` instead of honoring
// OPENCLAW_STATE_DIR / CODEX_HOME. On Railway, $HOME is the ephemeral
// container layer — so without these links, agent memory and Codex
// OAuth tokens silently die on every redeploy.
export function ensurePersistentLinks(): void {
  const home = os.homedir();
  ensureSymlink(path.join(home, ".openclaw"), STATE_DIR);
  ensureSymlink(path.join(home, ".codex"), path.join(STATE_DIR, "codex-home"));
}

function ensureSymlink(linkPath: string, target: string): void {
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {}
  try {
    const st = fs.lstatSync(linkPath);
    if (st.isSymbolicLink()) {
      try {
        if (fs.readlinkSync(linkPath) === target) return;
      } catch {}
      fs.unlinkSync(linkPath);
    } else {
      // Real directory exists; move aside so the symlink can take its
      // place. Contents in here would have been lost on next redeploy
      // anyway — the rename preserves them for forensic inspection.
      fs.renameSync(linkPath, `${linkPath}.ephemeral.${Date.now()}`);
    }
  } catch {
    // ENOENT — fresh container, nothing to move aside
  }
  try {
    fs.symlinkSync(target, linkPath, "dir");
    console.log(`[snapclaw] linked ${linkPath} → ${target} (persistent)`);
  } catch (err) {
    console.warn(`[snapclaw] failed to link ${linkPath}: ${(err as Error).message}`);
  }
}

export const sleep = (ms: number) =>
  new Promise((r) => setTimeout(r, ms));

interface CmdResult {
  code: number;
  output: string;
}

export function runCmd(
  cmd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let output = "";
    proc.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (output += d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      output += "\n[timeout]\n";
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: String(err) });
    });
  });
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(sk-ant-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{20,})/g, "[REDACTED]")
    .replace(/(\d{5,}:[A-Za-z0-9_-]{10,})/g, "[REDACTED]");
}

export function claw(...args: string[]): [string, string[]] {
  return ["openclaw", args];
}
