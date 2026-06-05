import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR, WORKSPACE_DIR, GATEWAY_TOKEN, SETUP_PASSWORD } from "./config.js";

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
      // Don't let these forensic copies accumulate across redeploys.
      pruneOldFiles(path.dirname(linkPath), `${path.basename(linkPath)}.ephemeral.`, 2);
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

// Keep only the newest `keep` entries in `dir` whose name starts with `prefix`,
// deleting the rest. Used to stop timestamped config backups and ephemeral
// directories from growing without bound on the persistent volume. Names carry
// an ISO/epoch timestamp suffix, so a lexical sort is chronological.
export function pruneOldFiles(dir: string, prefix: string, keep: number): void {
  try {
    const matches = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort();
    for (const f of matches.slice(0, Math.max(0, matches.length - keep))) {
      try {
        fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

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
  let out = text
    .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    // Telegram bot token (<digits>:<secret>)
    .replace(/\d{5,}:[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    // 64-hex blobs: the gateway token, sha256 session tokens, etc.
    .replace(/\b[A-Fa-f0-9]{64}\b/g, "[REDACTED]")
    // JSON/CLI access|refresh|id token fields
    .replace(
      /(["']?(?:access|refresh|id)_token["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{10,}/gi,
      "$1[REDACTED]",
    )
    // Authorization: Bearer <token>
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, "$1[REDACTED]");

  // Redact known literal secrets by exact value, covering tokens (e.g. a
  // custom OPENCLAW_GATEWAY_TOKEN that isn't 64-hex) no generic pattern catches.
  for (const secret of [GATEWAY_TOKEN, SETUP_PASSWORD]) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function claw(...args: string[]): [string, string[]] {
  return ["openclaw", args];
}
