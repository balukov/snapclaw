import { spawn } from "node:child_process";
import { STATE_DIR, WORKSPACE_DIR } from "./config.js";

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
