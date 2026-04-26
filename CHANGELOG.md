# Changelog

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
