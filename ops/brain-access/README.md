# Brain access boundary

The daytime `main` agent runs filesystem and shell tools through OpenClaw's SSH
sandbox as `brain-daytime` (UID 2100). The gateway, Sync, and dreaming retain
their existing `node` identity. `/data/.openclaw`, `/data/.config`, and
`/home/node` are private to the gateway identity. The SSH server listens only
on loopback and disallows password login and forwarding.

Daytime knowledge access is through `brain_wiki` and `brain_session`. The
gateway selects the current note from a persistent, host-session-key mapping;
the model cannot supply a pathname or another session key. A different goal
title starts a different note. Old notes remain untouched. Restarting reuses
the same association. Writes require the revision returned by the last read.

The worker can edit projects in its own workspace, but does not inherit host
Git credentials. The explicit tool allowlist excludes host browser, arbitrary
message attachments, administration, other-agent delegation, and legacy memory
tools. Normal channel replies remain available. Add capabilities only with an
equivalent isolation boundary, never by exposing host exec or the whole vault.

`brain-dreaming` is a separate maintenance agent with the original Brain
workspace. Only the nightly `Brain dreaming` automation should target it. The daytime
agent cannot spawn it or change the automation. DREAMS.md is written only by
the dreaming role, one diary entry per productive night (since 2026-10-18).

## Install and activate

1. Deploy the image containing this directory, the SSH package, and entrypoint
   changes. Keep `/data` on the existing persistent volume.
2. As root, run `sh /snapclaw/ops/brain-access/setup-ssh.sh`.
3. Save the current config privately for rollback. As node, run
   `node /snapclaw/ops/brain-access/configure.mjs --apply`, then
   `openclaw config validate`. If validation fails, restore the saved config.
4. Run `openclaw automations edit 31c4ab01-77f0-4669-b99c-6e98ad21c4dc --agent brain-dreaming`.
   Preserve its schedule, payload, and delivery settings.
5. Create `/data/.openclaw/brain-access-enabled`. Future container starts then
   recreate the Unix account/SSH daemon and reapply the same scoped configuration.
6. Restart the gateway and inspect `openclaw sandbox explain --agent main` and
   `--agent brain-dreaming`. Main must use SSH, with elevated execution disabled;
   dreaming must retain the Brain workspace without that sandbox.
7. Run `gosu node node /snapclaw/ops/brain-access/check-ssh.mjs`, verify the tools
   in a fresh daytime turn, and check the next dreaming run. Do not report a
   complete rollout from config validation alone.

Rollback: remove the marker, restore the saved config, retarget the same
automation to `main`, and restart the gateway. Private directory modes can stay:
the original gateway/Sync identity still owns them. Do not delete session notes.

## Checks and limits

- `node --test test/brain-access.test.mjs`: scope, traversal, symlinks, hardlinks,
  stale revisions, session identity, restart, goal switch, and role policy.
- `node ops/brain-access/check-ssh.mjs` on the gateway as node: the installed
  OpenClaw transport, project writes, denied Brain reads/writes and symlink bypass.
- `npm test`: wrapper regressions.

The sync process and owner remain trusted. Revision comparison rejects changes
already present at save time; it is not a cross-device distributed transaction.
The current note mapping is persistent gateway state, not synchronized knowledge.
Existing conversation history is not erased. Automatic decision to save still
depends on the agent following save-session; the tool enforces where it can save.

## Rollout status (2026-10-18)

Deployed image `ce609bb4-b0ed-44d7-83b1-9063ada55ca1`. Main now uses the SSH
boundary; the nightly `Brain dreaming` automation targets `brain-dreaming` with its
original schedule and payload. The startup marker is enabled on the persistent
volume. The deployed wrapper also drops obsolete browser timeout keys rejected
by OpenClaw 2026.9.2 and passes gateway authentication through config rather than
process arguments.

The real daytime agent verified UID 2100, denied host Brain reads, project file
editing, wiki access, and session saving. Its note synchronized to the Mac with
an identical SHA-256. This test used an isolated conversation without channel
delivery. After a supervised gateway restart, the same conversation read and
updated the same note; its updated SHA-256 again matched on the Mac. The
automation retained its maintenance-agent assignment after restart. The next
scheduled dreaming run is still to be observed.
