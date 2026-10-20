#!/bin/sh
set -eu
# Run as root before the gateway; the worker never inherits the gateway environment.
if ! id brain-daytime >/dev/null 2>&1; then
  useradd --uid 2100 --home-dir /data/brain-daytime --shell /bin/sh brain-daytime
  usermod -p '*' brain-daytime
fi
install -d -o brain-daytime -g brain-daytime -m 700 /data/brain-daytime
install -d -o node -g node -m 700 /data/.openclaw/brain-access-ssh
chmod 700 /data/.openclaw /data/.config /home/node
key=/data/.openclaw/brain-access-ssh/id_ed25519
if [ ! -f "$key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$key"
fi
chown node:node "$key" "$key.pub"
chmod 600 "$key"
install -o root -g root -m 644 "$key.pub" /etc/ssh/brain-daytime-authorized_keys
host=/data/.openclaw/brain-access-ssh/host_ed25519
if [ ! -f "$host" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host"
fi
install -d -m 755 /run/sshd
cat > /etc/ssh/sshd_config_brain <<EOF
Port 2223
ListenAddress 127.0.0.1
HostKey $host
PidFile /run/sshd-brain.pid
AllowUsers brain-daytime
AuthorizedKeysFile /etc/ssh/brain-daytime-authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
DisableForwarding yes
PermitUserEnvironment no
PermitTTY no
Subsystem sftp internal-sftp
EOF
awk '{print "[127.0.0.1]:2223 " $1 " " $2}' "$host.pub" > /data/.openclaw/brain-access-ssh/known_hosts
chown node:node /data/.openclaw/brain-access-ssh/known_hosts
chmod 600 /data/.openclaw/brain-access-ssh/known_hosts
/usr/sbin/sshd -t -f /etc/ssh/sshd_config_brain
if [ ! -f /run/sshd-brain.pid ] || ! kill -0 "$(cat /run/sshd-brain.pid)" 2>/dev/null; then
  /usr/sbin/sshd -f /etc/ssh/sshd_config_brain
fi
