import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Environment ---

export const PORT = parseInt(process.env.PORT ?? "3000", 10);

export const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");

export const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// --- Setup password ---
// SETUP_PASSWORD is the ONLY thing standing between the public internet and the
// admin panel + root shell + the operator's OAuth tokens (OpenClaw's own device
// auth is intentionally delegated away). An empty value used to silently open
// all of that to anyone with the URL. Instead: take the env var if set, allow an
// explicit local-dev opt-out, otherwise generate a strong password, persist it to
// the volume (stable across redeploys), and log it once so the operator can find it.
function resolveSetupPassword(): string {
  const env = process.env.SETUP_PASSWORD?.trim();
  if (env) return env;

  if (process.env.SNAPCLAW_ALLOW_NO_AUTH === "1") {
    console.warn(
      "[snapclaw] SNAPCLAW_ALLOW_NO_AUTH=1 — admin panel is UNAUTHENTICATED. Local dev only.",
    );
    return "";
  }

  const file = path.join(STATE_DIR, "setup-password");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) {
      console.warn(
        "[snapclaw] SETUP_PASSWORD not set; reusing the generated admin password " +
          "from the volume. Set SETUP_PASSWORD to choose your own.",
      );
      return existing;
    }
  } catch {}

  const generated = crypto.randomBytes(12).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch {}
  console.warn(
    "[snapclaw] SETUP_PASSWORD is not set — the admin panel and terminal would " +
      "otherwise be open to the public internet.\n" +
      `[snapclaw] Generated a temporary admin password: ${generated}\n` +
      "[snapclaw] Set SETUP_PASSWORD in your environment to choose your own.",
  );
  return generated;
}

export const SETUP_PASSWORD = resolveSetupPassword();

export const INTERNAL_PORT = parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);

export const GATEWAY_TARGET = `http://127.0.0.1:${INTERNAL_PORT}`;

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

// --- Session secret ---
// HMAC key for admin login cookies. Persisted to the volume so it survives
// redeploys — a per-boot random key logged every operator out on each restart.
function resolveSessionSecret(): string {
  const file = path.join(STATE_DIR, "session.secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch {}
  return generated;
}

export const SESSION_SECRET = resolveSessionSecret();

// --- Config helpers ---

// A partial, deliberately loose view of openclaw.json — just the fields
// SnapClaw reads. `[k: string]: unknown` index signatures keep it from
// fighting the many other keys OpenClaw writes that we don't care about.
export interface OpenclawModel {
  name?: string;
  id?: string;
  model?: string;
  slug?: string;
}

export interface OpenclawConfig {
  gateway?: { mode?: string; [k: string]: unknown };
  channels?: {
    telegram?: { botToken?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  agents?: {
    defaults?: { model?: string | OpenclawModel; [k: string]: unknown };
    [k: string]: unknown;
  };
  auth?: { profiles?: Record<string, unknown>; [k: string]: unknown };
  commands?: { ownerAllowFrom?: unknown[]; [k: string]: unknown };
  plugins?: {
    entries?: Record<string, unknown>;
    allow?: unknown[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

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

export function readConfig(): OpenclawConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as OpenclawConfig;
  } catch {
    return null;
  }
}
