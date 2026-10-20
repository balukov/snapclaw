import fs from 'node:fs';

export const daytimeTools = ['exec', 'process', 'read', 'write', 'edit', 'apply_patch',
  'web_search', 'progress_card', 'ask_user', 'brain_wiki', 'brain_session'];
// Dreaming ingests notes written by the sandboxed daytime agent, so it gets file tools and
// exec for hashing only: no browser, web, messaging, delegation or admin surface.
export const dreamingTools = ['exec', 'process', 'read', 'write', 'edit', 'apply_patch'];
const pluginDir = '/snapclaw/ops/brain-access';

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
    tools: { allow: dreamingTools, elevated: { enabled: false } },
  };
  cfg.tools ??= {};
  cfg.tools.sandbox = { ...cfg.tools.sandbox, tools: { allow: daytimeTools, deny: [] } };
  cfg.plugins ??= {};
  cfg.plugins.load ??= {};
  cfg.plugins.load.paths = [...new Set([...(cfg.plugins.load.paths || []).filter(p => p !== root + '/extensions/brain-access'), pluginDir])];
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
  const file = root + '/openclaw.json';
  const cfg = configure(JSON.parse(fs.readFileSync(file, 'utf8')), root);
  fs.writeFileSync(file + '.brain-tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.brain-tmp', file);
}
