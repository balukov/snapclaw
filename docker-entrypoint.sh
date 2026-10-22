#!/bin/sh
set -e

if [ -d /data ] && [ "$(stat -c %u /data)" != "1000" ]; then
  chown -R node:node /data
fi

[ -d /data/.openclaw/npm ] && chown -R node:node /data/.openclaw/npm 2>/dev/null || true

[ -f /data/.openclaw/openclaw.json ] && chown node:node /data/.openclaw/openclaw.json 2>/dev/null || true

mkdir -p /data/.config && chown -R node:node /data/.config

if [ -f /data/.openclaw/brain-access-enabled ]; then
  sh /snapclaw/ops/brain-access/setup-ssh.sh
  gosu node node /snapclaw/ops/brain-access/configure.mjs --apply
elif grep -q '"backend": "ssh"' /data/.openclaw/openclaw.json 2>/dev/null; then
  echo "[brain-access] WARNING: /data/.openclaw/brain-access-enabled is missing but openclaw.json still sandboxes the main agent over SSH; no sshd will run and its exec/read/write tools will fail. Restore the marker or roll the config back (ops/brain-access/README.md)." >&2
fi

exec gosu node "$@"
