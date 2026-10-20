import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../ops/brain-access/store.mjs';
import { configure, daytimeTools } from '../ops/brain-access/configure.mjs';
import plugin from '../ops/brain-access/index.mjs';

test('plugin binds memory to host context and refuses other agents', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-plugin-')));
  try {
    fs.mkdirSync(root + '/vault/wiki', { recursive: true });
    fs.writeFileSync(root + '/vault/wiki/index.md', 'Index');
    let factory;
    plugin.register({ pluginConfig: { vault: root + '/vault', state: root + '/state' },
      registerTool: value => { factory = value; } });
    assert.equal(factory({ agentId: 'brain-dreaming', sessionKey: 'other' }), null);
    assert.equal(factory({ agentId: 'main' }), null);
    const tools = factory({ agentId: 'main', sessionKey: 'trusted-host-session' });
    const session = tools.find(t => t.name === 'brain_session');
    await session.execute('tool-call-id', { action: 'start', title: 'Scoped goal' });
    await assert.rejects(session.execute('tool-call-id', { action: 'read', sessionKey: 'forged' }));
    const restored = JSON.parse((await session.execute('id', { action: 'read' })).content[0].text);
    assert.equal(restored.title, 'Scoped goal');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('daytime tools are isolated; dreaming remains a separate role', () => {
  const cfg = configure({ plugins: { entries: { telegram: { enabled: true } } } });
  assert.equal(cfg.agents.entries.main.sandbox.mode, 'all');
  assert.equal(cfg.agents.entries.main.tools.exec.host, 'sandbox');
  assert.equal(cfg.agents.entries.main.tools.elevated.enabled, false);
  assert.equal(cfg.agents.entries['brain-dreaming'].sandbox.mode, 'off');
  for (const escape of ['gateway', 'cron', 'nodes', 'browser', 'sessions_spawn', 'message']) {
    assert.equal(daytimeTools.includes(escape), false);
  }
  assert.equal(cfg.plugins.entries.telegram.enabled, true);
  assert.deepEqual(configure(structuredClone(cfg)), cfg);
});

test('Brain capability confines reads and saves; restores only the host-bound goal', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-access-')));
  try {
    const vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
    fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'wiki/index.md'), 'Wiki');
    fs.writeFileSync(path.join(vault, 'secret.md'), 'PRIVATE');
    const store = createStore(vault, state);
    assert.equal(store.wiki(), 'Wiki');
    assert.throws(() => store.wiki('../secret.md'));
    fs.symlinkSync(path.join(vault, 'secret.md'), path.join(vault, 'wiki/link.md'));
    assert.throws(() => store.wiki('link.md'));
    fs.linkSync(path.join(vault, 'secret.md'), path.join(vault, 'wiki/hard.md'));
    assert.throws(() => store.wiki('hard.md'));
    const initial = store.session('host-a', { action: 'start', title: 'Goal A' });
    const saved = store.session('host-a', { action: 'save', revision: initial.revision, body: 'Decision A' });
    assert.throws(() => store.session('host-a', { action: 'save', revision: initial.revision, body: 'Lost update' }));
    const restarted = createStore(vault, state);
    assert.deepEqual(restarted.session('host-a', { action: 'read' }), saved);
    assert.throws(() => restarted.session('host-b', { action: 'read' }));
    assert.throws(() => restarted.session('host-a', { action: 'read', path: 'secret.md' }));
    const next = restarted.session('host-a', { action: 'start', title: 'Goal B' });
    assert.notEqual(next.path, saved.path);
    assert.equal(next.text, '');
    assert.match(fs.readFileSync(path.join(vault, saved.path), 'utf8'), /Decision A/);
    assert.equal(restarted.session('host-a', { action: 'start', title: 'Goal B' }).path, next.path);
    fs.symlinkSync(path.join(vault, 'secret.md'), path.join(vault, next.path));
    assert.throws(() => restarted.session('host-a', { action: 'read' }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
