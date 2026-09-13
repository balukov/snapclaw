# Obsidian Sync for the workspace

SnapClaw ships the Obsidian Sync headless client (`ob`). Once you connect the
workspace to a remote vault, `ob sync --continuous` runs next to the gateway and
the same folder appears in Obsidian on your Mac and phone. Hidden folders
(`.git`, `memory/.dreams`) are never uploaded.

You need an [Obsidian Sync](https://obsidian.md/sync) subscription (Standard is
enough: one vault, 1 GB, 5 MB per file).

## One-time setup

Open **Terminal** in the SnapClaw panel (it runs as the `node` user with the
right environment). If you'd rather use your own shell, `railway ssh` then
`gosu node sh` gets you the same thing:

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

## If the badge stays "Not set up" after the setup

SnapClaw checks the folder named by the `OPENCLAW_WORKSPACE_DIR` variable. It
must be the same path you passed to `ob sync-setup` (`/data/.openclaw/workspace`
on a standard deploy); an older value such as `/data/workspace` makes the panel
look in an empty folder. Fix the variable in Railway and let the service redeploy.

## If the badge says "Configured, not running"

The client keeps exiting; the Railway log shows a `[sync] exited code=…` line,
and the client's own output just above it says why. The usual cause is an
expired login: repeat `ob login` over SSH, then press **Check**.
`ob sync-status --path /data/.openclaw/workspace` prints the current
configuration.
