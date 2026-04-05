import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Environment ---

export const PORT = parseInt(process.env.PORT ?? "3000", 10);
export const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim() ?? "";

export const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

export const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

export const INTERNAL_PORT = parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);

export const GATEWAY_TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;

export const OPENCLAW_BIN = process.env.OPENCLAW_BIN?.trim() || "openclaw";

// --- Gateway token ---

function resolveToken(): string {
  const env = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (env) return env;

  const tokenFile = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenFile, "utf8").trim();
    if (existing) return existing;
  } catch {}

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenFile, generated, { mode: 0o600 });
  } catch {}
  return generated;
}

export const GATEWAY_TOKEN = resolveToken();
process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_TOKEN;

// --- Config helpers ---

export function configPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  return path.join(STATE_DIR, "openclaw.json");
}

export function isConfigured(): boolean {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

export function readConfig(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
}
