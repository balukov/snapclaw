# Upgrading and recovering SnapClaw

What has to be up after any deploy or restart, how to tell, and how to get back.
Pinned OpenClaw: `ARG OPENCLAW_VERSION` in the `Dockerfile` (2026.9.2 when this
was written).

Four things run on one service and one volume (`/data`):

| Part | Process | Needs the gateway? |
| --- | --- | --- |
| OpenClaw gateway (Telegram, daytime agent) | `openclaw gateway run`, child of SnapClaw | — |
| Telegram pairing | `.channels-ready` flag + OpenClaw's pairing table | yes, for messages |
| Obsidian Sync | `ob sync --continuous`, child of SnapClaw | no |
| Brain connector for Claude | `/mcp` in SnapClaw's own HTTP server | no |

Brain (the connector and Sync) does not depend on the gateway. A broken or
refused gateway takes Telegram down, not Brain.

## Green CI is not a deploy, and a deploy is not "up"

- `npm test` proves the lifecycle logic against stand-in `openclaw` and `ob`
  binaries (`test/recovery.test.mjs`: steady state, upgrade, restart, crashes,
  rollback). It does not run the real OpenClaw, Obsidian, Telegram or Railway.
- Railway's health check (`/healthz`) turns green as soon as SnapClaw listens.
  It returns `ok: true` even when `gateway` is `"down"`, and says nothing about
  Sync or Brain.
- Call a deploy done only after every readiness check below passes.

## Before upgrading OpenClaw

1. Bump `OPENCLAW_VERSION` in a PR, read OpenClaw's release notes for state or
   config changes, and get `npm test` green.
2. Do not change `SETUP_PASSWORD` in the same deploy: it is part of the
   connector's signing key, so changing it signs Claude out of Brain.
3. Make sure the volume has room for one more copy of `/data/.openclaw` minus
   `workspace/` and `browser/` (`du -sh` in the panel Terminal).

On the first boot of a new version SnapClaw copies OpenClaw's state to
`/data/.openclaw/backups/pre-migration-<time>-<old>-to-<new>/`, then runs
`openclaw doctor --fix`, then records the version in `openclaw-version`. The
copy leaves out the vault (Obsidian Sync carries it), browser profiles, and
SnapClaw's own state (`session.secret`, `setup-password`, `gateway.token`,
`brain-*`), so restoring it never signs Claude out or rewinds Brain session
notes. One copy per version pair; the newest two are kept.

## Readiness checks (after every deploy)

1. Railway log of the new deployment, in order: `pre-migration snapshot: …` and
   `state migration complete` (only when the version changed), then
   `[snapclaw] gateway ready` and `[snapclaw] obsidian sync: running`.
   No `REFUSING TO START`, no `no pre-migration snapshot`.
2. `/snapclaw/api/status` (logged in): `gatewayRunning: true`,
   `obsidianSync: "running"`, `channelsReady: true`, `openclawVersion` is the
   pinned version.
3. Telegram: message the bot and get a reply.
4. Claude: read `index.md` through the Brain connector without reconnecting.
5. Obsidian: a note change on the Mac shows up on the volume, and one saved
   from Claude shows up on the Mac.
6. If `/data/.openclaw/brain-access-enabled` exists: the checks in
   `ops/brain-access/README.md` (`check-ssh.mjs`, `sandbox explain`).

## When something is down

| Symptom | Cause | Do |
| --- | --- | --- |
| `gateway: "down"` for a few seconds after a crash | auto-restart with 1s–30s backoff | wait; if it stays down, panel → **Restart gateway** and read the log |
| `[gateway] REFUSING TO START` | the image's OpenClaw is older than the one that migrated the volume | redeploy the newer version, or roll back with the snapshot (below) |
| `doctor --fix exited …` | migration failed; marker not written | fix the cause; the next boot retries and keeps the first snapshot |
| Sync `Configured, not running` | `ob` keeps exiting, usually an expired login | `docs/OBSIDIAN-SYNC.md` |
| Sync `Not set up` after a deploy | `OPENCLAW_WORKSPACE_DIR` points elsewhere | `docs/OBSIDIAN-SYNC.md` |
| Claude asks to reconnect Brain | `SETUP_PASSWORD` or `session.secret` changed | reconnect the connector in claude.ai |
| Panel says "Waiting for pairing" | flag lost and OpenClaw moved its pairing table | send the bot `/start`, approve the code in the panel |

## Rolling back after a migration

OpenClaw does not read state migrated by a newer version. SnapClaw refuses to
start an older gateway on it and never runs the older `doctor` over it. That
guard lives in SnapClaw itself, so a commit from before it (before DEV-168)
would run the older `doctor` over migrated state the moment it boots. Never roll
back by redeploying an old commit.

1. On top of the current `main`, commit only the `OPENCLAW_VERSION` change back
   to the older version, and deploy that. Expect `REFUSING TO START`; Brain and
   Sync stay up.
2. In the panel Terminal, remove the newer version marker and copy the snapshot
   back. The marker goes first because a snapshot taken on a volume that had no
   marker yet has none to copy over it:
   ```
   ls /data/.openclaw/backups/
   rm -f /data/.openclaw/openclaw-version
   cp -a /data/.openclaw/backups/pre-migration-<time>-<old>-to-<new>/. /data/.openclaw/
   ```
3. Panel → **Restart gateway**, then run the readiness checks. If the snapshot
   had no marker, the older `doctor` runs once on the restored state, as it
   did before the upgrade.

Snapshots exist only for migrations run by a SnapClaw that has this guard.
Anything OpenClaw recorded after the upgrade (chats, pairings, auth changes) is
lost. With no snapshot, the way back is forward: redeploy the newer version.
To start the older gateway on migrated state anyway, at your own risk, write the
installed version into `/data/.openclaw/openclaw-version` and restart the gateway.

## Checked on the live service only

The tests cannot cover these; check them by hand on the first deploy of a new
OpenClaw version:

- the real `openclaw doctor --fix` for that version migrates and the gateway
  starts on the result;
- the real older OpenClaw starts on a restored snapshot;
- Telegram pairing still reads after the real migration;
- Railway keeps `/data` and the snapshot fits on it;
- Obsidian Sync resumes with the stored login after a redeploy.
