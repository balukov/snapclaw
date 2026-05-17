# Changelog

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
