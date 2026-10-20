// Run as node on the gateway host. No model calls and no changes to Brain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createSshSandboxSessionFromSettings, runSshSandboxCommand, disposeSshSandboxSession,
} from '/app/dist/plugin-sdk/sandbox.js';

const settings = {
  command: 'ssh', target: 'brain-daytime@127.0.0.1:2223', strictHostKeyChecking: true,
  updateHostKeys: false,
  identityFile: '/data/.openclaw/brain-access-ssh/id_ed25519',
  knownHostsFile: '/data/.openclaw/brain-access-ssh/known_hosts',
};
for (const file of ['/data/.openclaw/workspace/wiki/index.md', '/data/.openclaw/openclaw.json']) {
  assert.equal(fs.statSync(file).isFile(), true);
}
const session = await createSshSandboxSessionFromSettings(settings);
try {
  const result = await runSshSandboxCommand({ session, remoteCommand: `python3 - <<'PY'
import os, pathlib, tempfile
assert os.getuid() == 2100
blocked = ['/data/.openclaw/workspace/wiki/index.md', '/data/.openclaw/openclaw.json',
           '/data/.openclaw/workspace/raw', '/data/.openclaw/brain-access-ssh/id_ed25519']
for file in blocked:
    for mode in (os.O_RDONLY, os.O_WRONLY):
        try:
            fd = os.open(file, mode)
        except PermissionError:
            continue
        else:
            os.close(fd)
            raise AssertionError('Private path accessible')
with tempfile.TemporaryDirectory(dir='/data/brain-daytime') as temporary:
    root = pathlib.Path(temporary)
    (root/'project.txt').write_text('editable project')
    assert (root/'project.txt').read_text() == 'editable project'
    (root/'alias').symlink_to('/data/.openclaw/workspace/wiki/index.md')
    try:
        (root/'alias').read_text()
    except PermissionError:
        pass
    else:
        raise AssertionError('Symlink bypass')
import socket, urllib.request, urllib.error
try:
    urllib.request.urlopen('http://127.0.0.1:18789/api/health', timeout=3)
    raise AssertionError('Gateway API answered an unauthenticated request from the sandbox')
except urllib.error.HTTPError as error:
    assert error.code in (401, 403), error.code
except (urllib.error.URLError, OSError):
    pass
for port in (9222, 9229):
    with socket.socket() as probe:
        probe.settimeout(1)
        assert probe.connect_ex(('127.0.0.1', port)) != 0, f'debug port {port} reachable from the sandbox'
print('PASS: OpenClaw SSH transport; project writes allowed; Brain reads/writes, symlink bypass, unauthenticated gateway and debug ports denied')
PY` });
  assert.equal(result.code, 0);
  process.stdout.write(result.stdout);
} finally { await disposeSshSandboxSession(session); }
