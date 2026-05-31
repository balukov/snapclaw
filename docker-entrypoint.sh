#!/bin/sh
set -e

# Fix volume permissions for non-root user (Railway mounts /data as root)
if [ -d /data ] && [ "$(stat -c %u /data)" != "1000" ]; then
  chown -R node:node /data
fi

# --- Keep the Codex plugin in lockstep with the pinned OpenClaw core ---
#
# Onboarding installs the non-bundled `@openclaw/codex` plugin onto the
# volume (/data/.openclaw/npm). Unlike the ~90 stock plugins bundled in the
# image, it does NOT update when the core image is bumped, so after a core
# upgrade the volume copy is left stale (e.g. codex 2026.5.12 against core
# 2026.5.27). A stale Codex harness can't serve the model the new core
# configures — "agent harness codex does not support openai/gpt-5.5" — which
# silently breaks every agent reply while the bot still polls.
#
# Two things must hold, and both require root — the gateway itself runs as the
# unprivileged `node` user (see `gosu node` below) and can do neither:
#   1. Version match: reinstall the plugin when it drifts from the core.
#   2. Ownership: OpenClaw 2026.5.27+ refuses to load plugins not owned by
#      root ("suspicious ownership"). An npm-installed plugin is owned by the
#      installing user, so re-own the volume plugin tree to root.
#
# All best-effort: a failure here must never block container boot.
PLUGIN_ROOT=/data/.openclaw/npm/node_modules
CODEX_PKG="$PLUGIN_ROOT/@openclaw/codex/package.json"
if [ -f "$CODEX_PKG" ]; then
  CORE_VER=$(openclaw --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1 || true)
  CODEX_VER=$(grep -m1 '"version"' "$CODEX_PKG" | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/' || true)
  if [ -n "$CORE_VER" ] && [ -n "$CODEX_VER" ] && [ "$CORE_VER" != "$CODEX_VER" ]; then
    echo "[snapclaw] codex plugin $CODEX_VER != core $CORE_VER — updating"
    openclaw plugins update </dev/null >/dev/null 2>&1 \
      || echo "[snapclaw] codex plugin update failed (continuing with $CODEX_VER)"
  fi
fi
# Re-own the volume plugin tree to root so the ownership check passes (covers
# both the onboarding install and any update above). Idempotent.
if [ -d "$PLUGIN_ROOT" ]; then
  chown -R 0:0 "$PLUGIN_ROOT" 2>/dev/null || true
fi

exec gosu node "$@"
