# Changelog

## 0.11.0

- **Obsidian Sync sidecar.** The image ships `obsidian-headless` 0.0.14. Connect the workspace to a remote vault once over SSH (`ob login`, `ob sync-setup`, see `docs/OBSIDIAN-SYNC.md`) and SnapClaw runs `ob sync --continuous` next to the gateway, restarting it with a 5s–60s backoff. The client's login token and sync state live in `/data/.config/obsidian-headless` (`XDG_CONFIG_HOME=/data/.config`), so they survive redeploys. Hidden folders such as `.git` and `memory/.dreams` are never uploaded.
- **Panel:** an *Obsidian Sync* row in the Admin card shows `Syncing`, `Configured, not running` or `Not set up`; **Check** calls `POST /snapclaw/api/sync/ensure`, which re-reads the vault configuration and starts the client without a redeploy. `/snapclaw/api/status` gains `obsidianSync`.
- **Removed dead surface.** The panel API keeps only what the panel uses: the raw config editor, backup export/import, devices list/approve, manual onboard, reset, the "mark as paired" override and the console command map are gone (use the panel Terminal for `openclaw …`). `tar` and `tsx` dependencies dropped; `docker-compose.yml` dropped (Railway is the only deploy target). Pairing state is the `.channels-ready` flag written by pairing approval, nothing else. `INTERNAL_GATEWAY_PORT`, `OPENCLAW_CONFIG_PATH` and `SNAPCLAW_ALLOW_NO_AUTH` are no longer read. The boot-time browser doctor run is gone. The model badge now shows `agents.defaults.model.primary`.
- **Image:** the sync client's `better-sqlite3` addon is installed with `--allow-scripts` (npm 12 blocks install scripts of global packages by default) and the build fails early if the addon cannot be loaded.

## 0.10.0

- **OpenClaw 2026.5.27 → 2026.9.2.** Redeploy to pick it up. The first boot runs OpenClaw's own state migration (`openclaw doctor --fix --non-interactive`, about a minute on Railway) and records the OpenClaw version on the volume so it runs once per version, not per boot. Your Telegram pairing and ChatGPT login carry over. **Export a backup from the panel before redeploying** — a 5.27 gateway cannot read a volume that 9.2 has migrated, so the export is the only rollback.
- **The first message after the upgrade may start a fresh session.** OpenClaw 9.x scopes DM sessions per channel peer and re-runs its identity setup, so the bot may greet you as new and ask what to call it once; memory files on the volume are untouched.
- **Control UI now needs one click per browser.** OpenClaw retired `gateway.controlUi.dangerouslyDisableDeviceAuth`, so browsers must device-pair. The panel's **Open Web UI** button goes through `openclaw dashboard`'s single-use owner handoff instead: click it once in each browser and the Control UI is authorised, nothing to approve. Bookmarks of the bare domain show "pairing required" until you do.
- **ChatGPT login is provider `openai`.** OpenClaw removed the `openai-codex` provider; first-time onboarding and re-authentication use `openai`, and doctor rewrites existing `openai-codex/*` model refs to `openai/*` while keeping the Codex runtime. The "Codex connected" indicator now asks `openclaw models auth list` instead of reading `openclaw.json`, where auth profiles no longer live.
- **Telegram bot is added with `openclaw channels add`,** which enables the plugin as well as storing the token; `config set` alone stopped doing that in 9.x.
- **Removed the codex plugin reinstall, the root re-own and the sudo helper.** The 2026.9.2 image bundles codex, doctor refreshes any stale volume copy itself, and the ownership check accepts the running user. The global grammy install is gone for the same reason (bundled with the Telegram plugin). Node 24 in the base image; the terminal's `node-pty` is now built on Node 24 to match.
- **`~/.openclaw` stays on the volume.** The 2026.9.2 image ships an empty `/home/node/.openclaw` in an image layer, and overlayfs refuses to rename a lower-layer directory (`EXDEV`), so the symlink to `/data/.openclaw` silently failed on first boot. It is copied aside and replaced now; the boot log reads `linked /home/node/.openclaw → /data/.openclaw (persistent)` again. The entrypoint also hands `/data/.openclaw/npm` back to `node` so the gateway can retire the legacy codex copy the 0.9.x entrypoint left root-owned.
- **Retired config keys no longer written:** `gateway.controlUi.allowInsecureAuth` (made `openclaw.json` invalid under 9.2's strict schema on every boot), `gateway.controlUi.dangerouslyDisableDeviceAuth`, `channels.telegram.pollingStallThresholdMs`. The `OPENCLAW_TELEGRAM_POLL_STALL_MS` variable is removed.
- **Memory search defaults to FTS-only** (`memory.search.provider: "none"`, set only if you have not set it). ChatGPT OAuth cannot serve embedding requests, so the default left `memory_search` reporting memory unavailable. Add an OpenAI API key and set the provider yourself to turn embeddings on. `update.checkOnStart` is off — SnapClaw pins the version.
- **Background model use is now on by default:** OpenClaw's doctor creates a 30-minute heartbeat monitor and a nightly memory consolidation job for the agent. Both spend turns on your ChatGPT quota. To stop the heartbeat: `openclaw config set agents.defaults.heartbeat.every 0m` from the panel terminal, then restart the gateway.
- Panel console: logs come from `openclaw logs --limit N --plain`; the config dump reads `openclaw.json` directly; doctor runs non-interactively. `npm test` runs the new helper tests on Node's built-in runner.

## 0.9.20

- **Deployments now report which SnapClaw version they run.** There was no way to answer "is this instance on the release that fixed X?" — SnapClaw never read its own `package.json`, and the only version it surfaced was `openclawVersion`, which is OpenClaw's. The version is now logged once at boot (so it appears in Railway logs) and returned as `snapclawVersion` from `/snapclaw/api/status`. Deliberately **not** added to the public `/healthz`: that would let anyone scan deployments and enumerate which are running an unpatched release, which matters for a template with many third-party installs.

## 0.9.19

- **Security: the OpenClaw gateway was reachable without a password.** `checkAuth()` guarded only `/snapclaw*`; every other path fell through to the gateway proxy, which stamped `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN` onto the request before forwarding it. `SETUP_PASSWORD` never participated, so anyone who knew a deployment's public URL reached OpenClaw Control as an authenticated admin. Confirmed against a live deployment before the fix — an anonymous `GET` returned the Control UI. The root redirect to `/snapclaw` was not a gate: it fires only while channels are unready, and only for `/`. **Action for existing deploys: redeploy to pick this up.** Every gateway-proxied request now requires the setup session (or the Basic-auth path), and unauthenticated requests get the login page.
- **WebSocket upgrades are authenticated and origin-checked.** The upgrade handler was a separate code path that never called `checkAuth()`, so it inherited the same hole — and any future WS route would have inherited it silently. Upgrades now require the session and are refused when `Origin`'s host does not match `Host`. That origin check is not optional: WebSockets bypass CORS, so a cookie-gated socket is otherwise open to cross-site hijacking from any page. Handshakes with no `Origin` proceed to the auth check, since that attack is browser-only and non-browser clients omit the header. `/snapclaw/terminal` is unchanged — its single-use 60-second token already gated it.
- **The gateway token now replaces client credentials rather than filling in when absent.** `checkAuth()` accepts HTTP Basic, whose header carries `SETUP_PASSWORD`. The old conditional injection forwarded that header downstream, leaking the admin password into the gateway process; it also broke the API clients the Basic path exists to serve, since the gateway expects its own bearer token.
- **Dependency vulnerabilities patched:** `tar` 7.5.13 → 7.5.22 (critical file-smuggling plus five others), `ws` 8.20.0 → 8.21.1 (high: uninitialized memory disclosure, memory-exhaustion DoS), `follow-redirects` 1.15.11 → 1.16.0 (moderate: auth headers leaked across cross-domain redirects). `ws` backs both the terminal and the gateway proxy.
- **HTTP security headers.** `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY` on every response. A Content-Security-Policy applies to SnapClaw's own routes only — OpenClaw Control is a third-party SPA whose asset requirements move with upstream releases, so policing it here would break it on some future version. The login page's inline `<style>` moved to `public/login.css`, served publicly since the login page is by definition unauthenticated. `style-src` does carry `'unsafe-inline'`: xterm.js sizes and themes its viewport by assigning to `element.style` at runtime, and CSSOM writes have no hash or nonce escape hatch. `script-src` stays strict, which is the directive standing between an injected script and the shell.

## 0.9.18

- **Route-table refactor.** The ~390-line if/else chain in `handleRequest` is now 19 named handlers registered in two dispatch tables keyed by `"METHOD /path"` — `publicRoutes` (healthz, icon; no auth) and `setupRoutes` (16 routes behind the auth gate). Dispatch itself is ~55 lines: public lookup → login special-case → auth gate → setup lookup → 404/proxy fallback. Exact-match semantics are unchanged; handlers are now individually testable.
- **Typed config.** New `OpenclawConfig` interface for the slice of `openclaw.json` SnapClaw reads (`channels.telegram.botToken`, `agents.defaults.model`, `auth.profiles`, `commands.ownerAllowFrom`, `plugins`); `readConfig()` returns it. Removed every `as Record<string, unknown>` cast in `checkChannelsReady` and the status handler.
- **Login page externalized to `public/login.html`** (was an inline template string in `index.ts`), with the error message injected via placeholder — and now HTML-escaped, closing a latent injection vector in the login error path. Minimal inline fallback if the file is missing.
- **Dead code removed:** unused `claw()` helper and `OPENCLAW_BIN` export.

## 0.9.17

- **Faster boots and gateway restarts.** `gateway.ensureConfig()` ran ~15 separate `openclaw config set` subprocesses on every boot — each a full CLI cold-start, which is slow on Railway's constrained CPU. It now reads `openclaw.json` once, applies all settings in a single in-memory pass, and writes once (zero config subprocesses). It bails without writing if the config is unreadable, so it can't clobber a present-but-corrupt config.
- **Removed the redundant post-setup config pass.** `applyPostSetupConfig()` re-set values that `ensureConfig()` already applies on the gateway start/restart every onboard path triggers (its `trustedProxies` was a superset; `gateway.bind`/`port` come from the `onboard`/`gateway run` flags). Deleted it and both call sites; the `BOOTSTRAP.md` cleanup moved into `ensureConfig()`.
- Side fix: boolean gateway flags (`allowInsecureAuth`, `dangerouslyDisableDeviceAuth`) are now written as canonical JSON `true` instead of the bare string `"true"` the old non-`--json` `config set` produced.

## 0.9.16

- **Gateway crash watchdog.** If the OpenClaw gateway exits unexpectedly, SnapClaw now auto-restarts it with exponential backoff (1s→30s, reset on a healthy boot). Previously a crash left the bot silently down — Telegram polling stopped — until the next proxied HTTP request happened to trigger a restart. Deliberate stops/restarts are exempt from the watchdog, and a late exit event from an old process can no longer null out a freshly-restarted one.
- **Single guarded gateway start.** `ensure()`, `restart()`, and the watchdog now share one in-flight start instead of risking a double-spawn under concurrent triggers.
- **`/healthz` tells the truth.** The body now reports gateway liveness (`running`/`down`/`unconfigured`) and `/api/status` exposes `gatewayRunning`, while `/healthz` stays HTTP 200 so the in-process watchdog (not a container kill) owns recovery. `waitReady` no longer treats a 5xx as "ready".
- **Backups stay a sane size and don't pile up.** Export now excludes the regenerable Chromium profile/cache (often hundreds of MB) and backup clutter, and awaits stream completion instead of returning mid-flight. Import stops the gateway first (no extracting over open files), streams straight from the request (no full in-memory buffer), and always restarts afterward. Timestamped config backups are capped at 10 and `.ephemeral.*` forensic dirs at 2, so the volume no longer grows without bound.

## 0.9.15

- **Security hardening.** Several changes that close gaps in the admin panel, which sits on a public Railway domain and is the only thing guarding the agent's root shell and OAuth tokens:
  - **An empty `SETUP_PASSWORD` no longer opens everything to the internet.** Previously a deploy that forgot the env var left the admin panel, config editor, and terminal wide open. Now SnapClaw uses the env var if set, honors an explicit `SNAPCLAW_ALLOW_NO_AUTH=1` opt-out for local dev, and otherwise **generates a strong password, persists it to the volume, and logs it once** so the operator can find it in Railway logs. **Action for existing password-less deploys:** after upgrading, grab the generated password from the logs or set `SETUP_PASSWORD` yourself.
  - **Login brute-force protection.** Per-IP lockout (5 failed attempts → 15-minute cooldown) on both the login form and the Basic-auth API path; the login page shows a "try again in N min" message.
  - **Constant-time credential checks.** Password and session-cookie comparisons now use `crypto.timingSafeEqual` instead of `===`, removing a timing side channel.
  - **Persistent session secret.** The login-cookie HMAC key is now stored on the volume instead of regenerated each boot, so operators are no longer logged out on every redeploy. Cookies also get the `Secure` flag when served over HTTPS.
  - **Broader secret redaction.** Console/CLI output now redacts 64-hex blobs (gateway/session tokens), `access`/`refresh`/`id_token` fields, `Bearer` tokens, and the literal gateway token and setup password — so commands like `config get .` can't leak them.

## 0.9.14

- **Close the fresh-install gap so new deploys work without a second redeploy.** v0.9.13 fixed existing installs (the entrypoint re-owns the codex plugin to root at boot), but a brand-new install hit the OpenClaw 2026.5.27+ ownership check: first-time onboarding installs the codex plugin as the unprivileged `node` user, so it stayed node-owned — and therefore blocked — until the *next* container restart. New users had to redeploy once after setup.
- The gateway runs as `node` and can't `chown` to root itself, so this adds a **narrow `sudo` helper**: `scripts/own-plugins.sh` (installed root-owned at `/usr/local/bin/snapclaw-own-plugins`) re-owns the plugin tree to root, and a NOPASSWD sudoers rule (`/etc/sudoers.d/snapclaw`, validated with `visudo` at build time) lets `node` run *only* that helper. The helper takes no arguments and has a hardcoded target, so the grant can't be repurposed; the script stays root-owned and non-writable by `node`. `gateway.start()` invokes it right after `ensureConfig()` and before the gateway process loads plugins, so a freshly onboarded codex plugin becomes root-owned in the same session — no restart. Best-effort: if the helper is absent (e.g. local dev), it's logged and skipped, never blocking gateway start.

## 0.9.13

- **Fix the v0.9.12 codex auto-reconcile (it didn't work).** v0.9.12 ran `openclaw plugins update` to refresh the stale codex plugin, but that command is interactive and refuses to overwrite an already-installed plugin (`plugin already exists … rerun install with --force`), so under the entrypoint's non-interactive shell it just failed and left the plugin at the old version. Replaced with the verified, deterministic invocation: `openclaw plugins install npm:@openclaw/codex@$CORE_VER --pin --force` — pins codex to the exact core version and replaces the stale copy. Confirmed against a live deployment (2026.5.12 → 2026.5.27, harness mismatch resolved, bot replies).
- **Don't let a root-owned config lock out the gateway.** Reinstalling the plugin runs as root and can leave config/records root-owned; the gateway runs as `node` and then can't read `openclaw.json` (`EACCES: permission denied` → `Gateway start blocked: missing gateway.mode` → exit 78). The entrypoint now re-asserts `node` ownership of the state tree after a reinstall, and unconditionally keeps `openclaw.json` node-owned on every boot. (This also self-heals instances left root-owned by running `openclaw config set …` over `railway ssh`, which executes as root.)
- Net effect: existing users **update by redeploying** — bump nothing, the entrypoint reconciles codex to the pinned core and fixes ownership automatically. **Known gap for *fresh* installs:** first-time onboarding installs codex as `node`, so the root-ownership re-own only lands on the **next** boot — a brand-new deploy may need one redeploy after setup. A `sudo`-based post-onboarding re-own to close that gap is tracked separately.

## 0.9.12

- **Keep the Codex plugin in lockstep with the OpenClaw core.** The non-bundled `@openclaw/codex` plugin is installed by onboarding onto the volume (`/data/.openclaw/npm/node_modules/@openclaw/codex`), and — unlike the ~90 stock plugins bundled in the image — it does **not** update when the core image is bumped. After the v0.9.11 core pin to `2026.5.27`, the volume copy was left stale at `2026.5.12`. A stale Codex harness can't serve the model the new core configures, so every agent reply failed with *"Requested agent harness codex does not support openai/gpt-5.5 (provider is not one of: codex)"* — the bot kept polling Telegram but answered with *"Something went wrong while processing your request."* This was the real cause behind the whole "missing API key → re-auth wiped config → no replies" sequence: the volume-pinned codex plugin silently drifting away from the `:latest`-tracking core.
- `docker-entrypoint.sh` now reconciles this on every boot, in the **root** context (the gateway runs as the unprivileged `node` user and can do neither of these): (1) if the installed codex plugin version differs from the core (`openclaw --version`), it runs `openclaw plugins update` to bring it forward; (2) it `chown`s the volume plugin tree to root so it satisfies OpenClaw 2026.5.27+'s plugin **ownership check** (it blocks plugins not owned by root as *"suspicious ownership"* — the npm install runs as `node`/uid 1000). Both steps are best-effort and never block boot.
- Note for fresh installs: first-time onboarding installs codex as `node`, so the ownership re-own applies on the **next** container restart — message the bot, and if it doesn't answer, redeploy once.

## 0.9.11

- **Pin the OpenClaw base image instead of tracking `:latest`.** The runtime stage built `FROM ghcr.io/openclaw/openclaw:latest`, so the underlying OpenClaw could change under SnapClaw on any rebuild — with no deliberate version bump and no record of which version was deployed. That rolling base is also awkward to update on Railway, where the cached `FROM :latest` layer often isn't re-pulled, so "redeploy" can silently keep the old OpenClaw. And because re-auth assumes OpenClaw's `models auth login` leaves the rest of the config intact, an unannounced OpenClaw behavior change is a latent config-loss risk. Now pinned via `ARG OPENCLAW_VERSION` (currently `2026.5.27`, the latest stable): updates are an explicit one-line bump, builds are reproducible, and the version reference changes on bump so the base layer is genuinely re-pulled. `docker-compose.yml` documents overriding it via the build arg.

## 0.9.10

- Add an "Already paired? Mark as connected" link in the Step 2 *"Waiting for pairing code..."* state. The auto-detection in `checkChannelsReady()` only flips to `true` on signals it can verify (approved devices, `commands.ownerAllowFrom` non-empty, persistent `.channels-ready` flag). It can miss bots that were paired in a previous SnapClaw session and survived via persistent config state the heuristics don't recognize — the bot works in Telegram, but the setup UI is stuck in pending. The new link calls a new `POST /snapclaw/api/channels/mark-ready` endpoint that writes the `.channels-ready` flag directly, treating the user as the source of truth.

## 0.9.9

- **Re-authenticate no longer wipes the whole config.** v0.9.8 wired the "Re-authenticate" link to `startCodexSession()`, which deletes `openclaw.json` before running `openclaw onboard` — so a user clicking it lost their Telegram bot token, pairing state, and any other settings. After that, the gateway booted with only 3 plugins (no telegram), and the bot effectively disappeared from polling. Now: if a config already exists, re-auth runs `openclaw models auth login --provider openai-codex` instead — narrow, OAuth-only, leaves everything else intact. (This is exactly what OpenClaw's own "Model login expired" error tells users to run.) First-time onboarding still uses the full `openclaw onboard` flow with the config wipe.
- **Self-heal the `.channels-ready` flag.** When the v0.9.8 re-auth wiped the config, the persistent `.channels-ready` file on the volume was left in place — so `checkChannelsReady()` kept returning `true` and the setup UI hid the "add bot token" input, leaving the user with no UI path to recover. `checkChannelsReady()` now sanity-checks against `channels.telegram.botToken`: if the flag is set but the bot token is gone, the flag is stale and gets cleared. Existing broken deployments will self-heal on the next status poll after upgrading.

## 0.9.8

- Add a "Re-authenticate" link under Step 1 when Codex shows as connected. The `codexConnected` status only checks that an `auth.profiles` entry exists in the config — it can't tell whether the underlying OAuth tokens still work. When OpenClaw later returns "Model login expired on the gateway for openai-codex" (e.g. after the v0.9.6 redeploy nuked `~/.codex`), users had no way to re-trigger OAuth from the UI without going through `/reset` and rerunning the whole onboarding wizard. The new link reveals the connect UI and calls the existing `/snapclaw/api/codex/start` flow, which already kills any prior session before starting a fresh one.

## 0.9.7

- Fix Codex OAuth tokens dying on every redeploy. Symptom after v0.9.6: bot finally responds (since v0.9.6 unblocked the telegram plugin), but the first message back is *"Model login expired on the gateway for openai-codex. Re-auth with openclaw models auth login --provider openai-codex, then try again."* Cause: Codex auth tokens are written under `$HOME/.codex` by default, and `$HOME` (`/home/node`) is the Railway-ephemeral container layer. Same class of bug as v0.9.2's memory fix.
- Generalized the symlink helper from gateway.ts into a shared `ensurePersistentLinks()` that now sets up both `~/.openclaw → STATE_DIR` (memory) and `~/.codex → STATE_DIR/codex-home` (auth). Run it at server startup (before any `openclaw onboard` subprocess) and again on every gateway boot, so existing deployments self-heal.
- Note: the user still has to re-authenticate Codex once after upgrading to v0.9.7, because the auth lost in the v0.9.6 redeploy can't be recovered. After re-auth, the tokens will be on the persistent volume and survive future redeploys.

## 0.9.6

- **Critical regression fix**: v0.9.2 set `plugins.allow = ["codex"]` to silence a startup warning, but OpenClaw treats `plugins.allow` as an **exclusive allowlist** (only listed plugins are permitted to load) rather than a non-bundled trust list. The effect: every bundled plugin — telegram, browser, memory-core, canvas, file-transfer, device-pair, phone-control, talk-voice — was being blocked. Users who installed SnapClaw fresh on v0.9.2 through v0.9.5 would see Codex auth complete, save a Telegram bot token, then message the bot and get no response, because the telegram plugin never started polling. Reset `plugins.allow` to `[]` on every boot — actively, so existing deployments that picked up the bad config self-heal on next restart.

## 0.9.5

- Fix the setup UI showing **Step 3: "You're all set!"** in green as soon as Codex OAuth finished, before Telegram was paired. The dashboard div (which contains the success block) was unconditionally shown whenever `configured=true`, on the assumption that admin/terminal access should be reachable during incomplete setup. Kept that intent — the admin section still appears as soon as the agent is configured — but moved the "You're all set!" header + "Open Web UI" button into a new `#dashboardReady` wrapper that is only revealed when `channelsReady=true`. Pairs with v0.9.4's tightened pairing detection: now the green checkmark only appears when the user has actually completed Telegram pairing.

## 0.9.4

- Fix false-positive "Telegram bot is connected" state on fresh installs. After saving a bot token, `checkChannelsReady()` was returning true via two over-eager heuristics: (1) `plugins.entries.<channel>` matches as soon as OpenClaw registers the telegram plugin, before any pairing handshake; (2) `openclaw channels list` mentions the channel name as soon as the bot token is configured. Both fire while the user has never even messaged the bot. Worse, the false state was then persisted to `/data/.openclaw/.channels-ready`, so refreshing the setup UI kept reporting "connected" forever even though the bot had never responded with a pairing code. Replaced both with strict pairing signals: an approved device in `openclaw devices list`, or a non-empty `commands.ownerAllowFrom` — neither of which gets populated just by writing a bot token.

## 0.9.3

- Fix `HTTP 400: {"ok":false,"error":"No active session"}` during fresh Codex OAuth setup. The PTY-backed onboarding session was being auto-killed after 5 minutes, but ChatGPT OAuth (sign-in + 2FA + approve + copy redirect URL) regularly takes longer on first-time setup — so the session was already dead by the time the user pasted the redirect URL. Bump the auto-cleanup to 30 minutes so the in-flight onboard process survives the full OAuth window.
- Improve the callback error message from the cryptic "No active session" to "Codex onboarding session expired or not started. Click 'Start Codex OAuth' to begin a new one." — so the next user who does hit the timeout knows the recovery action.

## 0.9.2

- **Persistent agent memory across redeploys.** OpenClaw's `memory-core` plugin writes daily memory markdowns to `$HOME/.openclaw/workspace/memory/` regardless of `OPENCLAW_STATE_DIR`. On Railway, `$HOME` (`/home/node`) is the ephemeral container layer, so the agent's long-term memory was being silently wiped on every redeploy for every SnapClaw user. Fix: pre-create `~/.openclaw` as a symlink to `STATE_DIR` before gateway boot, so any fallback writes land on the persistent volume. Idempotent on every boot; existing real `~/.openclaw` directories are moved aside (`.ephemeral.<ts>`) and replaced with the symlink — accept the one-time loss of writes that were already destined to evaporate.
- Stop running `openclaw doctor --fix` on every gateway boot. It's an unbounded auto-repair pass and has a track record of destructive migrations across OpenClaw releases (2026.5.5 doctor rewrote valid `openai-codex/*` OAuth routes, reverted in 5.6). SnapClaw's own `ensureConfig()` covers the targeted config writes we actually need; run `openclaw doctor --fix` manually when something is genuinely broken.
- Set `plugins.allow = ["codex"]` in `ensureConfig()` to silence the "plugins.allow is empty; discovered non-bundled plugins may auto-load: codex" warning that previously fired on every boot and on every inbound Telegram message. SnapClaw installs codex deliberately during onboarding, so explicit-trusting it is the correct posture.

## 0.9.1

- Bump the example `OPENCLAW_VERSION` in `docker-compose.yml` to `2026.5.12` (latest stable). Docs-only — the `Dockerfile` still tracks `ghcr.io/openclaw/openclaw:latest`, so Railway deployments already pick up new OpenClaw releases on rebuild.

## 0.9.0

- Setup UI design system refresh: replaced the ad-hoc inline CSS in `setup.html` with a token-driven design system in a new `public/setup.css` (color, type scale, 4px spacing scale, three radii, motion, elevation). Tightened the existing aesthetic without changing the orange-on-dark brand identity — no React, no Tailwind, no new dependencies.
- Concrete fixes: removed the gradient text on the page heading; softened the background grid pattern; replaced the lift-on-hover button transform with a calmer color/shadow shift; demoted the oversized "Open Web UI" hero to a regular dashboard button; bumped `<pre>` and `<code>` to a dedicated `--surface-2` for clearer hierarchy; added a real checkmark glyph to the "done" step state instead of just swapping the circle color; switched all focus rings to `:focus-visible`; tightened entrance animations from .6s/.4s to 250ms.
- Refreshed the login page (`sendLoginPage` in `src/index.ts`) to use the same token vocabulary, so login → setup is visually cohesive.
- Preserved every CSS class that `src/client/setup.ts` toggles as part of the setup state machine (`.hidden`, `.configured`, `.done`, `.status-badge.success`, `.status-badge.pending`) — this is purely a CSS change with zero behavior impact.
- New static-asset route `GET /snapclaw/setup.css` mirroring the existing `setup.js` route, served behind the same auth gate.

## 0.8.7

- Fix agents losing all tools except `browser` after upgrade: `tools.allow` *replaces* the profile's tool list (per OpenClaw docs), so any leftover entry like `["browser"]` from a prior config silently strips fs/exec/message/memory tools — agents then can't edit files, run commands, or write long-term memory, and report things like "no file editing tool available". Reset `tools.allow` to `[]` on every gateway boot alongside the existing `tools.alsoAllow` reset, so the `full` profile is always the effective tool set.

## 0.8.6

- Fix browser tool timing out on first use after Railway redeploys: Chromium's `SingletonLock`, `SingletonCookie`, and `SingletonSocket` files in the persisted browser profile dir referenced PIDs from the previous container, so the first launch attempt sat in retry/timeout limbo. OpenClaw's built-in stale-lock recovery kicks in only after the first attempt times out — too late for the agent's tool-call budget. Pre-clear the lock files at gateway boot so the first launch is clean.

## 0.8.5

- Diagnostics for the browser launch issue: log the resolved Chromium binary path on every gateway boot, run `--version` to verify it's executable, and run `openclaw browser doctor` in the background after gateway is ready so the actual launch failure (if any) lands in Railway logs instead of being relayed through the agent as a generic "Restart the OpenClaw gateway" timeout
- Widen the Chromium binary scan to also match `chromium_headless_shell-*` directories and the `headless_shell` binary, since Playwright bundles the headless shell as a separate distribution

## 0.8.4

- Fix browser tool timing out with "Restart the OpenClaw gateway" on Railway: OpenClaw 2026.4.24+ lazy-launches Chromium on first use with default budgets `localLaunchTimeoutMs: 15000` and `localCdpReadyTimeoutMs: 8000`. Railway's slow-IO volume mount needs more headroom; bump to 90s/30s
- Add Chromium launch flags that improve container reliability: `--disable-setuid-sandbox`, `--no-zygote`, `--no-first-run`, `--no-default-browser-check`, `--disable-background-networking`

## 0.8.3

- Hotfix: gateway crashed with `CIAO ANNOUNCEMENT CANCELLED` unhandled rejection on Railway because the v0.8.2 Bonjour disable lived in `applyPostSetupConfig`, which only runs during fresh onboarding. Move the Bonjour disable (and the optional `OPENCLAW_TELEGRAM_POLL_STALL_MS` env handling) into `gateway.ensureConfig` so they apply on every boot — existing deploys now pick them up on the first restart.

## 0.8.2

- Disable the Bonjour bundled plugin during post-setup config: Railway has no LAN to advertise to (new default-enabled plugin in OpenClaw 2026.4.24)
- Add optional `OPENCLAW_TELEGRAM_POLL_STALL_MS` env to set `channels.telegram.pollingStallThresholdMs` (configurable since OpenClaw 2026.4.20)
- Detect Codex onboarding completion by polling for the config file instead of grepping `"Updated openclaw.json"` from PTY stdout — that string is not a contract
- Bump the example `OPENCLAW_VERSION` in `docker-compose.yml` to `2026.4.24`

## 0.8.1

- Fix Chromium binary resolution in Docker (`chrome-linux64` subdir, not `chrome-linux`)
- Set `browser.executablePath` to Playwright's bundled Chromium so the gateway finds it on restart
- Switch tools policy to the `full` profile so the agent has both `browser` and `message` tools (the `coding` profile omits both; `allow` replaces the profile's list, `alsoAllow` extends it)
- Fix "[object Object]" on the Codex badge by normalizing `agents.defaults.model` when it's an object, not a string
- Fix Telegram card resurfacing after restart: widen `channelsReady` detection (regex plugin match, `channels.telegram` shape, `devices list` fallback) and persist a sentinel file on successful pairing
- Show the dashboard/terminal any time the agent is configured, not only when channels are ready, so admin access is always reachable

## 0.8.0

- Full browser automation support: click, type, fill, navigate, screenshot, PDF export, and more
- Install Playwright Chromium in Docker image using OpenClaw's bundled CLI
- Add efficient snapshot defaults for compact, token-friendly agent interactions
- Set `PLAYWRIGHT_BROWSERS_PATH` in Dockerfile and railway.toml for consistent browser discovery

## 0.7.0

- Merge dashboard into single step 3 card
- Auto-delete BOOTSTRAP.md after setup
- Add default git config for agent in container
- Hide telegram instructions and token input when connected
- Remove standalone Open Web UI link, check auth profiles for Codex state
