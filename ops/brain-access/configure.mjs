import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const daytimeTools = ['exec', 'process', 'read', 'write', 'edit', 'apply_patch',
  'web_search', 'web_fetch', 'progress_card', 'ask_user', 'brain_wiki', 'brain_session'];

export function configure(cfg, root = '/data/.openclaw') {
  cfg.agents ??= {};
  cfg.agents.entries ??= {};
  cfg.agents.entries.main ??= {};
  const main = cfg.agents.entries.main;
  main.default = true;
  main.workspace = root + '/daytime-seed';
  main.sandbox = { mode: 'all', backend: 'ssh', scope: 'agent', workspaceAccess: 'rw', ssh: {
    target: 'brain-daytime@127.0.0.1:2223', workspaceRoot: '/data/brain-daytime/workspaces',
    identityFile: root + '/brain-access-ssh/id_ed25519',
    knownHostsFile: root + '/brain-access-ssh/known_hosts', strictHostKeyChecking: true,
  } };
  main.tools = { ...main.tools, allow: daytimeTools, elevated: { enabled: false },
    exec: { host: 'sandbox' } };
  cfg.agents.entries['brain-dreaming'] = {
    ...cfg.agents.entries['brain-dreaming'], workspace: root + '/workspace', sandbox: { mode: 'off' },
  };
  cfg.tools ??= {};
  cfg.tools.sandbox = { ...cfg.tools.sandbox, tools: { allow: daytimeTools, deny: [] } };
  cfg.plugins ??= {};
  cfg.plugins.load ??= {};
  cfg.plugins.load.paths = [...new Set([...(cfg.plugins.load.paths || []), root + '/extensions/brain-access'])];
  cfg.plugins.entries ??= {};
  cfg.plugins.entries['brain-access'] = { enabled: true, config: {
    vault: root + '/workspace', state: root + '/brain-sessions',
  } };
  return cfg;
}

if (process.argv[2] === '--apply') {
  const root = process.env.OPENCLAW_STATE_DIR || '/data/.openclaw';
  const seed = root + '/daytime-seed';
  fs.mkdirSync(seed + '/skills/save-session', { recursive: true });
  for (const name of ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'skills/save-session/SKILL.md']) {
    fs.copyFileSync(root + '/workspace/' + name, seed + '/' + name);
  }
  fs.appendFileSync(seed + '/AGENTS.md', '\n\n## SnapClaw memory tools\n\nYou are the daytime snapclaw agent. Your shell workspace is isolated from Brain. Read wiki with brain_wiki (start with index.md). Follow save-session after meaningful results: brain_session start with the goal title, read, then save the merged body with its revision. The host retains the association across restarts. Call read to recover the current goal; do not start a different goal merely because the application restarted. Do not save via shell files: only brain_session writes the synchronized Brain note. When a tool is unavailable, report the limitation; do not try to bypass it.\n');
  const plugin = root + '/extensions/brain-access';
  fs.mkdirSync(plugin, { recursive: true });
  const source = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['store.mjs', 'index.mjs', 'openclaw.plugin.json', 'package.json']) {
    fs.copyFileSync(source + '/' + name, plugin + '/' + name);
  }
  const file = root + '/openclaw.json';
  const cfg = configure(JSON.parse(fs.readFileSync(file, 'utf8')), root);
  fs.writeFileSync(file + '.brain-tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.brain-tmp', file);
}
