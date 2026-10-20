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
fi

exec gosu node "$@"
