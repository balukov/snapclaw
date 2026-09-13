# Obsidian Sync for the SnapClaw workspace — design

Date: 2026-09-08. Status: approved in chat (option A, single-user instance).

## Goal

The OpenClaw workspace on the Railway volume (`/data/.openclaw/workspace`) becomes an Obsidian Sync vault. Obsidian on the Mac and iPhone shows and edits the same folder; changes flow both ways within seconds, while OpenClaw keeps using the folder as its workspace.

## Non-goals

- Login or vault-picker UI in the panel (SnapClaw has one user; setup is a one-time SSH runbook).
- More than one vault, Obsidian Publish, conflict-resolution UI.
- Changing what OpenClaw stores in the workspace.

## Verified facts (2026-09-08)

- `obsidian-headless` 0.0.14 on npm, `engines.node >= 22` (image has Node 24). Binary `ob`.
- Credentials and per-vault sync state live in `$XDG_CONFIG_HOME/obsidian-headless/` on Linux (`auth_token` file, state store keyed by vault id). `OBSIDIAN_AUTH_TOKEN` env overrides the token file.
- `ob login --email --password [--mfa]` is non-interactive when flags are given. `ob sync-create-remote --name --encryption end-to-end --password`, `ob sync-setup --vault --path --password --device-name`, `ob sync --continuous --path`, `ob sync-status --path --json` (exit code 2 when the path is not configured).
- The scanner skips every entry whose name starts with `.` — `.git`, `memory/.dreams`, `.obsidian` internals are never uploaded. Default conflict strategy `merge`, mode `bidirectional`.
- Obsidian Sync Standard: 1 vault, 1 GB, 5 MB per file, 1 month history. Sufficient.

## Design

### Image

`Dockerfile` runtime stage installs the client globally, pinned: `npm install -g obsidian-headless@0.0.14`. Global `ENV XDG_CONFIG_HOME=/data/.config` so the node user, the panel, and an SSH session all see the same token and sync state, and they survive redeploys.

`docker-entrypoint.sh` creates `/data/.config` and chowns it to `node` alongside the existing chown steps.

### Sidecar: `src/sync.ts`

Same shape as `gateway.ts`, much smaller:

- `isConfigured(): Promise<boolean>` — `runCmd("ob", ["sync-status", "--path", WORKSPACE_DIR, "--json"], 20_000)` returns code 0.
- `start()` — if configured and not running, `spawn("ob", ["sync", "--continuous", "--path", WORKSPACE_DIR], { stdio: "inherit" })`. On exit (unless stopping) schedule a restart with backoff `5s, 10s, 20s, 40s, 60s cap`, reset after 10 minutes of uptime.
- `stop()` — SIGTERM, SIGKILL after 10 s.
- `ensure()` — `start()` if not running.
- `state(): "running" | "configured" | "not-configured"`.
- Pure helper `nextBackoffMs(attempt: number): number` exported for the unit test.

The sidecar is independent of gateway restarts: `index.ts` calls `sync.ensure()` once at boot (after the gateway boot path) and `POST /snapclaw/api/sync/ensure` re-runs the check on demand (used right after the SSH setup, no redeploy needed).

### Panel

`GET /snapclaw/api/status` gains `obsidianSync: "running" | "configured" | "not-configured"` (from `sync.state()`, no subprocess call). The client shows one row "Obsidian Sync" with a badge: success `Syncing` / warning `Configured, not running` / muted `Not set up` and a small `Check` button that calls the ensure endpoint and refreshes status.

### One-time setup (runbook, `docs/OBSIDIAN-SYNC.md`)

Run over `railway ssh` as the `node` user (`gosu node sh`), with the vault named `Brain`:

```
ob login --email <email> --password <password>            # add --mfa <code> if enabled
ob sync-create-remote --name Brain --encryption end-to-end --password <vault-password>
ob sync-setup --vault Brain --path /data/.openclaw/workspace --password <vault-password> --device-name snapclaw
ob sync --path /data/.openclaw/workspace                   # first full upload, one-shot
```

Then press `Check` in the panel (or redeploy). On the Mac and iPhone: Obsidian → Sync → connect to remote vault `Brain` → enter the vault password. The account password never enters Railway variables; only the token file on the volume holds a session.

### Tests

`test/sync.test.mjs`: `nextBackoffMs` sequence and cap. `npm test` runs both test files.

### Docs and version

README: short "Obsidian Sync (optional)" section pointing to the runbook. CHANGELOG `0.11.0`. `package.json` 0.11.0.

## Risks and accepted trade-offs

- `obsidian-headless` is 0.0.x; the version is pinned and only bumped deliberately.
- Two writers (OpenClaw in the container, the user on the phone) can touch the same file; the client's `merge` strategy handles plain-text merges, and the rule stays: personas write their own folder, everyone appends to `memory/`.
- If the token expires or the vault is unlinked, `ob sync` exits repeatedly; the badge shows `Configured, not running`, the backoff keeps the log readable, and the fix is re-running `ob login` over SSH.
- `XDG_CONFIG_HOME` is global in the image; git and Chromium will also keep their config under `/data/.config`, which is harmless.
