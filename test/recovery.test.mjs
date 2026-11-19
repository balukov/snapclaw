// Boots the built server (dist/index.js) against stand-in `openclaw` and `ob`
// binaries on a throwaway volume, and walks one volume through the lifecycle in
// docs/UPGRADE-RECOVERY.md: steady state, upgrade, restart, crash, rollback
// without restore, restore. Brain (/mcp + sync) must answer at every step.
// Versions are the pinned one (Dockerfile OPENCLAW_VERSION) and the release
// before it. No real credentials or notes: every value below is a fixture.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { fakeBin } from "./fixtures/bin.mjs";

const OLD = "OpenClaw 2026.5.27 (fixture)";
const PINNED_VERSION = /ARG OPENCLAW_VERSION=(\S+)/.exec(fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"))[1];
const NEW = `OpenClaw ${PINNED_VERSION} (fixture)`;
const PASSWORD = "fixture-password";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "snapclaw-recovery-")));
const STATE = path.join(root, "data", ".openclaw");
const LOG = path.join(root, "calls.log");
const PATH = fakeBin(root);
let server = null;
const children = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  for (const name of ["fake-gateway.pid", "fake-ob.pid"]) if (alive(pid(name))) process.kill(pid(name), "SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
});

function seedVolume() {
  fs.mkdirSync(path.join(STATE, "state"), { recursive: true });
  fs.mkdirSync(path.join(STATE, "workspace", "wiki"), { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });
  fs.mkdirSync(path.join(root, "browsers"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "workspace", "wiki", "index.md"), "Fixture index");
  fs.writeFileSync(
    path.join(STATE, "openclaw.json"),
    JSON.stringify({ channels: { telegram: { botToken: "000000:fixture" } } }),
  );
  fs.writeFileSync(path.join(STATE, "openclaw-version"), OLD);
  const db = new DatabaseSync(path.join(STATE, "state", "openclaw.sqlite"));
  db.exec("create table channel_pairing_allow_entries (channel_key text, account_id text, entry text, sort_order integer, updated_at integer)");
  db.exec("insert into channel_pairing_allow_entries values ('telegram', 'default', '1000', 0, 0)");
  db.close();
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function boot(version, { expectGateway = "running" } = {}) {
  if (server) await shutdown();
  const port = await freePort();
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("RAILWAY_") || k.startsWith("OPENCLAW_")) delete env[k];
  Object.assign(env, {
    PORT: String(port),
    HOME: path.join(root, "home"),
    PATH,
    OPENCLAW_STATE_DIR: STATE,
    SETUP_PASSWORD: PASSWORD,
    PLAYWRIGHT_BROWSERS_PATH: path.join(root, "browsers"),
    FAKE_LOG: LOG,
    FAKE_OPENCLAW_VERSION: version,
    FAKE_OB_CONFIGURED: "1",
    FAKE_DOCTOR_RENAMES_PAIRING: "1",
  });
  const child = spawn(process.execPath, ["--no-warnings", new URL("../dist/index.js", import.meta.url).pathname], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  server = { child, exited, base: `http://127.0.0.1:${port}`, log: () => output };
  const settled = () =>
    expectGateway === "running" ? healthGateway().then((g) => g === "running") : output.includes("[snapclaw] gateway failed");
  if (!(await until(settled, 20_000))) {
    await shutdown();
    assert.fail(`boot did not settle (${expectGateway}):\n${output}`);
  }
  assert.ok(await until(() => alive(pid("fake-ob.pid")), 5_000), "Obsidian Sync client running after boot");
  return server;
}

async function shutdown() {
  const { child, exited } = server;
  child.kill("SIGTERM");
  const code = await exited;
  server = null;
  return code;
}

async function until(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await cond()) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}
const pid = (name) => {
  try {
    return Number(fs.readFileSync(path.join(STATE, name), "utf8"));
  } catch {
    return null;
  }
};
const alive = (p) => {
  if (!p) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
const calls = (what) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter((l) => l.includes(what)) : []);
const marker = () => fs.readFileSync(path.join(STATE, "openclaw-version"), "utf8").trim();
const config = () => JSON.parse(fs.readFileSync(path.join(STATE, "openclaw.json"), "utf8"));
const snapshots = () => {
  try {
    return fs.readdirSync(path.join(STATE, "backups"));
  } catch {
    return [];
  }
};

// docs/UPGRADE-RECOVERY.md, "Rolling back after a migration", step 2.
function restore(name) {
  fs.rmSync(path.join(STATE, "openclaw-version"), { force: true });
  fs.cpSync(path.join(STATE, "backups", name), STATE, { recursive: true, force: true, verbatimSymlinks: true });
}

const healthGateway = async () => (await (await fetch(server.base + "/healthz")).json()).gateway;

let cookie;
async function status() {
  if (!cookie) {
    const r = await fetch(server.base + "/snapclaw/login", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: PASSWORD }),
    });
    cookie = /snapclaw_session=[a-f0-9]+/.exec(r.headers.get("set-cookie"))[0];
  }
  return (await fetch(server.base + "/snapclaw/api/status", { headers: { cookie } })).json();
}

let tokens;
async function connect() {
  const verifier = "f".repeat(50);
  const params = new URLSearchParams({
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const allow = await fetch(server.base + "/oauth/authorize", {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
    body: params,
  });
  assert.equal(allow.status, 302);
  const code = new URL(allow.headers.get("location")).searchParams.get("code");
  const r = await fetch(server.base + "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  tokens = await r.json();
}

async function brain(name, args = {}) {
  const r = await fetch(server.base + "/mcp", {
    method: "POST",
    headers: { authorization: "Bearer " + tokens.access_token, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(r.status, 200, "connector token accepted");
  const result = (await r.json()).result;
  assert.ok(!result.isError, result.content[0].text);
  return name === "brain_wiki" ? result.content[0].text : JSON.parse(result.content[0].text);
}

async function brainUp(expectedTitle) {
  assert.equal(await brain("brain_wiki"), "Fixture index");
  const note = await brain("brain_session", { action: "read" });
  assert.equal(note.title, expectedTitle);
  return note;
}

test("steady state on the previous OpenClaw: gateway, pairing, sync and the Brain connector are up", async () => {
  seedVolume();
  await boot(OLD);
  assert.equal(calls("doctor").length, 0, "no migration when the marker matches");
  const s = await status();
  assert.equal(s.gatewayRunning, true);
  assert.equal(s.obsidianSync, "running");
  assert.equal(s.channelsReady, true, "pairing made before the flag existed is adopted");
  assert.ok(fs.existsSync(path.join(STATE, ".channels-ready")));
  await connect();
  const started = await brain("brain_session", { action: "start", title: "Before upgrade" });
  await brain("brain_session", { action: "save", revision: started.revision, body: "Saved on the old version" });
  assert.equal(await shutdown(), 0);
  assert.equal(alive(pid("fake-gateway.pid")), false, "SIGTERM stops the gateway");
  assert.equal(alive(pid("fake-ob.pid")), false, "SIGTERM stops the sync client");
});

test(`upgrade to the pinned OpenClaw (${PINNED_VERSION}): snapshot, one migration, everything comes back`, async () => {
  await boot(NEW);
  assert.equal(calls(`${NEW} doctor --fix`).length, 1);
  assert.equal(marker(), NEW);
  assert.equal(config().meta?.migratedBy, NEW);
  const snaps = snapshots();
  assert.equal(snaps.length, 1);
  assert.match(snaps[0], new RegExp(`2026\\.5\\.27-to-${PINNED_VERSION.replaceAll(".", "\\.")}$`));
  const snap = path.join(STATE, "backups", snaps[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(snap, "openclaw.json"), "utf8")).meta, undefined, "snapshot is pre-migration");
  assert.equal(fs.readFileSync(path.join(snap, "openclaw-version"), "utf8"), OLD);
  assert.ok(server.log().includes("pre-migration snapshot"));

  const s = await status();
  assert.equal(s.gatewayRunning, true);
  assert.equal(s.obsidianSync, "running");
  assert.equal(s.channelsReady, true, "pairing survives the migration that moved OpenClaw's table");
  const note = await brainUp("Before upgrade");
  assert.match(note.text, /Saved on the old version/);
  const next = await brain("brain_session", { action: "start", title: "After upgrade" });
  await brain("brain_session", { action: "save", revision: next.revision, body: "Saved on the new version" });
  assert.equal(await shutdown(), 0);
});

test("restart on the same version: no second migration, grants and pairing kept, new pairing accepted", async () => {
  await boot(NEW);
  assert.equal(calls("doctor").length, 1);
  assert.equal(snapshots().length, 1);
  const s = await status();
  assert.equal(s.channelsReady, true);
  await brainUp("After upgrade");
  const refreshed = await fetch(server.base + "/oauth/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
  });
  assert.equal(refreshed.status, 200, "refresh token from before the restarts still works");
  const approve = await fetch(server.base + "/snapclaw/api/pairing/approve", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ channel: "telegram", code: "2000" }),
  });
  assert.equal((await approve.json()).ok, true);
});

test("crashes: the gateway and the sync client come back by themselves; Brain answers meanwhile", async () => {
  const gw = pid("fake-gateway.pid");
  process.kill(gw, "SIGKILL");
  await brainUp("After upgrade");
  assert.ok(await until(async () => pid("fake-gateway.pid") !== gw && (await healthGateway()) === "running", 10_000), "gateway restarted");

  const ob = pid("fake-ob.pid");
  process.kill(ob, "SIGKILL");
  await brainUp("After upgrade");
  assert.ok(await until(() => pid("fake-ob.pid") !== ob && alive(pid("fake-ob.pid")), 10_000), "sync restarted");
  assert.equal((await status()).obsidianSync, "running");
  assert.equal(await shutdown(), 0);
});

test("rollback to the older image without restoring: gateway refuses, no downgrade doctor, Brain stays up", async () => {
  await boot(OLD, { expectGateway: "failed" });
  assert.ok(server.log().includes("REFUSING TO START"), server.log());
  assert.equal(calls(`${OLD} doctor`).length, 0, "the older doctor never touches migrated state");
  assert.equal(marker(), NEW, "marker still names the version that migrated the volume");
  assert.equal(config().meta?.migratedBy, NEW);
  assert.equal(await healthGateway(), "down");
  const s = await status();
  assert.equal(s.gatewayRunning, false);
  assert.equal(s.obsidianSync, "running");
  await brainUp("After upgrade");
  assert.equal(await shutdown(), 0);
});

test("rollback with the snapshot restored: the older gateway starts on its own state; Brain notes and grants are untouched", async () => {
  restore(snapshots().find((f) => f.includes("2026.5.27-to-")));
  await boot(OLD);
  assert.equal(calls(`${OLD} doctor`).length, 0);
  assert.equal(marker(), OLD);
  assert.equal(config().meta?.migratedBy, undefined);
  const s = await status();
  assert.equal(s.gatewayRunning, true);
  assert.equal(s.channelsReady, true);
  assert.equal(s.obsidianSync, "running");
  const note = await brainUp("After upgrade");
  assert.match(note.text, /Saved on the new version/, "the restore did not rewind the current Brain goal");
  assert.equal(await shutdown(), 0);
});

test("rollback of a volume that had no version marker: the restore clears the newer marker, the older gateway starts", async () => {
  fs.rmSync(path.join(STATE, "openclaw-version"));
  await boot(NEW);
  const snap = snapshots().find((f) => f.includes("unknown-to-"));
  assert.ok(snap, "snapshot taken from a marker-less volume");
  assert.equal(fs.existsSync(path.join(STATE, "backups", snap, "openclaw-version")), false);
  assert.equal(marker(), NEW);
  assert.equal(await shutdown(), 0);

  await boot(OLD, { expectGateway: "failed" });
  assert.ok(server.log().includes("REFUSING TO START"));
  assert.equal(await shutdown(), 0);

  restore(snap);
  await boot(OLD);
  assert.equal(marker(), OLD, "the older doctor ran once on the restored state and recorded its version");
  assert.equal((await status()).gatewayRunning, true);
  await brainUp("After upgrade");
  assert.equal(await shutdown(), 0);
});
