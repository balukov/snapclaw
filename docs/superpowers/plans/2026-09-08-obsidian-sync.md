# Obsidian Sync Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `ob sync --continuous` (Obsidian Sync headless client) inside the SnapClaw container so the OpenClaw workspace on the Railway volume is an Obsidian vault visible on the user's Mac and iPhone.

**Architecture:** A small supervisor module `src/sync.ts` (same shape as `gateway.ts`) spawns the `ob` client against `WORKSPACE_DIR`, restarts it with a capped backoff, and reports a three-valued state. `index.ts` starts it at boot, exposes the state in `/snapclaw/api/status`, and offers `POST /snapclaw/api/sync/ensure` so a one-time SSH setup takes effect without a redeploy. The image installs the pinned client and points its config dir at the volume.

**Tech Stack:** Node 24 / TypeScript (ESM, `tsc`), `node:test`, esbuild client bundle, Dockerfile on `ghcr.io/openclaw/openclaw:2026.9.2`, npm package `obsidian-headless@0.0.14`.

**Spec:** `docs/superpowers/specs/2026-09-08-obsidian-sync-design.md`

## Global Constraints

- No comments in code (repo rule). Rationale goes in commit messages and docs. Existing comments stay; do not add new ones.
- Pin the client: `obsidian-headless@0.0.14` exactly; `ENV XDG_CONFIG_HOME=/data/.config` set globally in the image.
- The sync target is `WORKSPACE_DIR` from `src/config.ts` (`/data/.openclaw/workspace` on Railway). Never hard-code the path in TypeScript.
- State names are exactly `"running" | "configured" | "not-configured"`; the status JSON field is exactly `obsidianSync`.
- Backoff sequence is exactly `5000, 10000, 20000, 40000, 60000` ms, capped at 60000, reset after 10 minutes of uptime.
- Endpoint name is exactly `POST /snapclaw/api/sync/ensure`, registered in `setupRoutes` (authenticated), response `{ ok: true, state }`.
- `npm test` must run both `test/upgrade.test.mjs` and `test/sync.test.mjs` and pass.
- Version becomes `0.11.0` in `package.json` and `CHANGELOG.md`.
- Commit after every task with the attribution trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Em3LPDdLGTEqUT5EsUjR9v
  ```

---

## File structure

- `src/sync.ts` (new) — supervisor for the `ob sync --continuous` child: `nextBackoffMs`, `isRunning`, `state`, `isConfigured`, `ensure`, `stop`.
- `test/sync.test.mjs` (new) — unit test for `nextBackoffMs`.
- `package.json` — version `0.11.0`, test script runs both test files.
- `Dockerfile`, `docker-entrypoint.sh` — install the client, persist its config dir.
- `src/index.ts` — boot, status field, ensure endpoint, shutdown.
- `src/client/setup.ts`, `public/setup.html`, `public/setup.css` — one "Obsidian Sync" row in the Admin card.
- `docs/OBSIDIAN-SYNC.md` (new), `README.md`, `CHANGELOG.md` — runbook and release notes.

---

### Task 1: `src/sync.ts` supervisor with a tested backoff

**Files:**
- Create: `src/sync.ts`
- Create: `test/sync.test.mjs`
- Modify: `package.json` (`version`, `scripts.test`)

**Interfaces:**
- Consumes: `WORKSPACE_DIR` from `src/config.ts`; `runCmd(cmd, args, timeoutMs): Promise<{ code: number; output: string }>` from `src/utils.ts`.
- Produces (used by Task 3):
  - `export type SyncState = "running" | "configured" | "not-configured"`
  - `export function nextBackoffMs(attempt: number): number`
  - `export function isRunning(): boolean`
  - `export function state(): SyncState`
  - `export async function isConfigured(): Promise<boolean>`
  - `export async function ensure(): Promise<SyncState>`
  - `export async function stop(): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/sync.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SETUP_PASSWORD = "test-password";
process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "snapclaw-sync-test-"));

const { nextBackoffMs } = await import("../dist/sync.js");

test("nextBackoffMs: 5s doubling to a 60s cap, negative attempts start at 5s", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map(nextBackoffMs),
    [5000, 10000, 20000, 40000, 60000, 60000, 60000],
  );
  assert.equal(nextBackoffMs(-1), 5000);
});
```

- [ ] **Step 2: Point `npm test` at both files and bump the version**

In `package.json` change:

```json
"version": "0.10.0",
```
to
```json
"version": "0.11.0",
```
and
```json
"test": "npm run build:server && node --test test/upgrade.test.mjs"
```
to
```json
"test": "npm run build:server && node --test test/upgrade.test.mjs test/sync.test.mjs"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: `test/sync.test.mjs` fails with `Cannot find module '.../dist/sync.js'`; `test/upgrade.test.mjs` still passes.

- [ ] **Step 4: Write `src/sync.ts`**

```ts
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
    if (Date.now() - startedAt > STABLE_UPTIME_MS) attempt = 0;
    const delay = nextBackoffMs(attempt);
    attempt++;
    console.warn(`[sync] restart in ${delay}ms (attempt #${attempt})`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, delay);
  });

  child.on("error", (err) => {
    console.error(`[sync] failed to start ob: ${err.message}`);
    if (proc === child) proc = null;
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: both files pass (`# pass 5` or similar, `# fail 0`).

- [ ] **Step 6: Commit**

```bash
git add src/sync.ts test/sync.test.mjs package.json
git commit -m "Add the Obsidian Sync sidecar supervisor

Spawns ob sync --continuous against the workspace, restarts it with a
5s-to-60s backoff that resets after ten minutes of uptime, and reports
running / configured / not-configured for the panel.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Em3LPDdLGTEqUT5EsUjR9v"
```

---

### Task 2: Image installs the client and persists its config dir

**Files:**
- Modify: `Dockerfile` (runtime stage, after the `tini gosu` apt block)
- Modify: `docker-entrypoint.sh`

**Interfaces:**
- Produces: `ob` on `PATH` for every process in the container; `XDG_CONFIG_HOME=/data/.config` in the environment of the panel, the gateway, and SSH shells; `/data/.config` owned by `node`.

- [ ] **Step 1: Add the client to the runtime stage**

In `Dockerfile`, directly after this block:

```dockerfile
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini gosu \
  && rm -rf /var/lib/apt/lists/*
```

add:

```dockerfile
RUN npm install -g obsidian-headless@0.0.14 \
  && ob --version
ENV XDG_CONFIG_HOME=/data/.config
```

- [ ] **Step 2: Persist and own the config dir**

In `docker-entrypoint.sh`, after the line

```sh
[ -f /data/.openclaw/openclaw.json ] && chown node:node /data/.openclaw/openclaw.json 2>/dev/null || true
```

add:

```sh
mkdir -p /data/.config && chown node:node /data/.config
```

- [ ] **Step 3: Verify the image builds and the client answers**

Run: `docker build -t snapclaw-sync-test . && docker run --rm --entrypoint sh snapclaw-sync-test -c 'ob --version && echo XDG=$XDG_CONFIG_HOME'`
Expected: prints `0.0.14` and `XDG=/data/.config`. If Docker is unavailable on this machine, run `npm test` instead, state in the report that the image build was not verified locally, and rely on the Railway build.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-entrypoint.sh
git commit -m "Install obsidian-headless in the image with its config on the volume

Pins obsidian-headless 0.0.14 and points XDG_CONFIG_HOME at /data/.config
so the ob login token and per-vault sync state survive redeploys. The
entrypoint creates the dir and hands it to node.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Em3LPDdLGTEqUT5EsUjR9v"
```

---

### Task 3: Boot, status, ensure endpoint and the panel row

**Files:**
- Modify: `src/index.ts` (imports; `handleStatus`; new `handleSyncEnsure`; `setupRoutes`; `server.listen` callback; SIGTERM handler)
- Modify: `src/client/setup.ts` (`StatusResponse`; `restoreUI`; new `renderSync`; button handler)
- Modify: `public/setup.html` (Admin card)
- Modify: `public/setup.css` (`.status-badge.muted`)

**Interfaces:**
- Consumes from Task 1: `import * as sync from "./sync.js"` with `sync.ensure(): Promise<SyncState>`, `sync.state(): SyncState`, `sync.stop(): Promise<void>`.
- Produces: `GET /snapclaw/api/status` includes `obsidianSync: "running" | "configured" | "not-configured"`; `POST /snapclaw/api/sync/ensure` returns `{ ok: true, state }`.

- [ ] **Step 1: Import and wire the server**

In `src/index.ts`, after

```ts
import * as gateway from "./gateway.js";
```

add

```ts
import * as sync from "./sync.js";
```

In `handleStatus`, add the field after `gatewayRunning`:

```ts
    gatewayRunning: gateway.isRunning(),
    obsidianSync: sync.state(),
```

After `handleMarkReady` add:

```ts
const handleSyncEnsure: Handler = async (_req, res) => {
  const state = await sync.ensure();
  sendJson(res, { ok: true, state });
};
```

In `setupRoutes`, after the `"POST /snapclaw/api/channels/mark-ready": handleMarkReady,` line add:

```ts
  "POST /snapclaw/api/sync/ensure": handleSyncEnsure,
```

In the `server.listen` callback, after the `if (isConfigured()) { ... gateway.start() ... }` block (still inside the callback), add:

```ts
  try {
    console.log(`[snapclaw] obsidian sync: ${await sync.ensure()}`);
  } catch (err) {
    console.error("[snapclaw] obsidian sync check failed:", err);
  }
```

In the SIGTERM handler, after `await gateway.stop();` add:

```ts
  await sync.stop();
```

- [ ] **Step 2: Build the server to verify the types**

Run: `npm run build:server`
Expected: no errors.

- [ ] **Step 3: Panel markup and badge style**

In `public/setup.html`, inside the Admin card, replace

```html
      <h3>Admin</h3>
      <div class="term-controls">
```

with

```html
      <h3>Admin</h3>
      <div class="sync-row">
        <span>Obsidian Sync</span>
        <span id="syncStatus"></span>
        <button id="syncCheckBtn" class="btn-secondary">Check</button>
      </div>
      <div class="term-controls">
```

In `public/setup.css`, after the `.status-badge.pending { ... }` rule add:

```css
.status-badge.muted {
  background: transparent;
  color: var(--text-muted);
  border-color: currentColor;
}
.sync-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: var(--space-3);
}
.sync-row .status-badge { margin-top: 0; }
```

`--text-muted` is defined at the top of `public/setup.css`.

- [ ] **Step 4: Client rendering and the Check button**

In `src/client/setup.ts`:

Change the badge type union so a muted badge is allowed:

```ts
function setBadge(el: HTMLElement, type: "success" | "pending" | "muted", text: string): void {
```

Add `obsidianSync` to `StatusResponse`:

```ts
interface StatusResponse {
  configured: boolean;
  codexConnected: boolean;
  channelsReady: boolean;
  botTokenSet: boolean;
  model?: string | null;
  openclawVersion?: string;
  obsidianSync?: "running" | "configured" | "not-configured";
}
```

After `restoreUI` add:

```ts
function renderSync(state: StatusResponse["obsidianSync"]): void {
  const el = $("syncStatus");
  if (state === "running") setBadge(el, "success", "Syncing");
  else if (state === "configured") setBadge(el, "pending", "Configured, not running");
  else setBadge(el, "muted", "Not set up");
}
```

At the end of `restoreUI` (inside the function, after the Telegram block) add:

```ts
  renderSync(s.obsidianSync);
```

Before the `// --- Init ---` section add the button handler:

```ts
$("syncCheckBtn").onclick = async () => {
  const btn = $("syncCheckBtn") as HTMLButtonElement;
  setLoading(btn, true, "Checking...");
  try {
    const r = await httpJson<{ ok: boolean; state: StatusResponse["obsidianSync"] }>(
      "/snapclaw/api/sync/ensure",
      { method: "POST" },
    );
    renderSync(r.state);
  } catch (e) {
    setBadge($("syncStatus"), "pending", `Error: ${e}`);
  } finally {
    setLoading(btn, false, "Check");
  }
};
```

- [ ] **Step 5: Build everything and run the tests**

Run: `npm run build && npm test`
Expected: esbuild bundles `public/setup.js` without errors; `tsc` clean; both test files pass.

- [ ] **Step 6: Smoke the endpoint locally**

Run:

```bash
SETUP_PASSWORD=x OPENCLAW_STATE_DIR=$(mktemp -d) PORT=3999 node dist/index.js > /tmp/snapclaw-smoke.log 2>&1 &
sleep 3
curl -s -u :x -X POST http://localhost:3999/snapclaw/api/sync/ensure; echo
curl -s -u :x http://localhost:3999/snapclaw/api/status | tr ',' '\n' | grep obsidianSync
kill %1
```

Expected: the ensure call returns `{"ok":true,"state":"not-configured"}` (no `ob` binary on the dev machine, so `runCmd` reports a non-zero code), and status shows `"obsidianSync":"not-configured"`. If the Basic-auth path needs a username, use `-u admin:x`; if auth still refuses, use the session login instead and note it in the report. Kill the process afterwards.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/client/setup.ts public/setup.html public/setup.css public/setup.js
git commit -m "Start Obsidian Sync at boot and show it in the panel

The panel reports obsidianSync in /snapclaw/api/status, renders an
Obsidian Sync row with a Check button, and POST /snapclaw/api/sync/ensure
re-checks the vault so a one-time SSH setup takes effect without a
redeploy. SIGTERM stops the client with the gateway.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Em3LPDdLGTEqUT5EsUjR9v"
```

`public/setup.js` is the tracked esbuild bundle; commit the rebuilt file with the source.

---

### Task 4: Runbook, README and changelog

**Files:**
- Create: `docs/OBSIDIAN-SYNC.md`
- Modify: `README.md` (add a section before `## Why people like it`; add `obsidian sync login` to the persisted list)
- Modify: `CHANGELOG.md` (new `## 0.11.0` entry at the top)

**Interfaces:**
- Consumes: endpoint and badge names from Task 3, paths from Task 2.

- [ ] **Step 1: Write the runbook**

Create `docs/OBSIDIAN-SYNC.md`:

````markdown
# Obsidian Sync for the workspace

SnapClaw ships the Obsidian Sync headless client (`ob`). Once you connect the
workspace to a remote vault, `ob sync --continuous` runs next to the gateway and
the same folder appears in Obsidian on your Mac and phone. Hidden folders
(`.git`, `memory/.dreams`) are never uploaded.

You need an [Obsidian Sync](https://obsidian.md/sync) subscription (Standard is
enough: one vault, 1 GB, 5 MB per file).

## One-time setup

Open a shell in the container as the `node` user:

```
railway ssh
gosu node sh
```

Log in and create the vault (pick a vault password; end-to-end encryption
means Obsidian's servers never see your notes):

```
ob login --email you@example.com --password '<account password>'
ob sync-create-remote --name Brain --encryption end-to-end --password '<vault password>'
ob sync-setup --vault Brain --path /data/.openclaw/workspace --password '<vault password>' --device-name snapclaw
ob sync --path /data/.openclaw/workspace
```

Add `--mfa <code>` to `ob login` if your account has two-factor auth. The
last command uploads the workspace once and exits.

Then open the SnapClaw panel and press **Check** next to *Obsidian Sync*. The
badge turns to **Syncing** and stays that way across redeploys: the login token
and sync state live in `/data/.config/obsidian-headless` on the volume.

## On your devices

Obsidian → Settings → Sync → connect to remote vault **Brain** → enter the vault
password. Do the same on the phone.

## If the badge says "Configured, not running"

The client keeps exiting; the Railway log shows why (`[sync]` lines). The usual
cause is an expired login: repeat `ob login` over SSH, then press **Check**.
`ob sync-status --path /data/.openclaw/workspace` prints the current
configuration.
````

- [ ] **Step 2: README**

In `README.md`, in the `## What gets persisted` list, add a line after `- workspace`:

```markdown
- Obsidian Sync login and state (if you set it up)
```

Before `## Why people like it` add:

```markdown
## Obsidian Sync (optional)

The workspace can be an Obsidian vault: connect it to Obsidian Sync once over
SSH and the same notes show up in Obsidian on your computer and phone. See
[docs/OBSIDIAN-SYNC.md](docs/OBSIDIAN-SYNC.md).

```

- [ ] **Step 3: Changelog**

At the top of `CHANGELOG.md`, after `# Changelog` and a blank line, add:

```markdown
## 0.11.0

- **Obsidian Sync sidecar.** The image ships `obsidian-headless` 0.0.14. Connect the workspace to a remote vault once over SSH (`ob login`, `ob sync-setup`, see `docs/OBSIDIAN-SYNC.md`) and SnapClaw runs `ob sync --continuous` next to the gateway, restarting it with a 5s–60s backoff. The client's login token and sync state live in `/data/.config/obsidian-headless` (`XDG_CONFIG_HOME=/data/.config`), so they survive redeploys. Hidden folders such as `.git` and `memory/.dreams` are never uploaded.
- **Panel:** an *Obsidian Sync* row in the Admin card shows `Syncing`, `Configured, not running` or `Not set up`; **Check** calls `POST /snapclaw/api/sync/ensure`, which re-reads the vault configuration and starts the client without a redeploy. `/snapclaw/api/status` gains `obsidianSync`.

```

- [ ] **Step 4: Verify links and run the tests one more time**

Run: `ls docs/OBSIDIAN-SYNC.md && grep -n "OBSIDIAN-SYNC" README.md CHANGELOG.md && npm test`
Expected: the file exists, both references print, tests pass.

- [ ] **Step 5: Commit**

```bash
git add docs/OBSIDIAN-SYNC.md README.md CHANGELOG.md
git commit -m "Document the Obsidian Sync setup and release 0.11.0 notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Em3LPDdLGTEqUT5EsUjR9v"
```
