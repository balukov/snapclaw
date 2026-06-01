#!/bin/sh
# Re-own the OpenClaw plugin tree to root (uid 0) so it satisfies OpenClaw
# 2026.5.27+'s plugin "ownership" check (it blocks plugins not owned by root
# as "suspicious ownership").
#
# The gateway runs as the unprivileged `node` user and installs the codex
# plugin as `node` during first-time onboarding — so on a fresh install the
# plugin is node-owned and blocked until the next boot re-owns it. This helper
# is invoked by the gateway via a narrow NOPASSWD sudoers rule so node-owned
# plugins become root-owned immediately, with no restart.
#
# Security: the target is hardcoded and the script takes NO arguments, so the
# sudo grant cannot be used to chown anything else. It must stay root-owned and
# non-writable by `node`.
set -e
PLUGIN_ROOT=/data/.openclaw/npm/node_modules
[ -d "$PLUGIN_ROOT" ] && chown -R 0:0 "$PLUGIN_ROOT"
exit 0
