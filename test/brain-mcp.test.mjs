import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createMcp } from '../ops/brain-access/mcp.mjs';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const b64url = buf => Buffer.from(buf).toString('base64url');

test('MCP connector: OAuth with PKCE, wiki-only reads, raw/claude-duet-only writes', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mcp-')));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'wiki/index.md'), 'Index');
  fs.writeFileSync(path.join(vault, 'wiki/Page.md'), 'Page');
  fs.writeFileSync(path.join(vault, 'secret.md'), 'PRIVATE');
  const handle = createMcp({ vault, state: path.join(dir, 'state'), secret: 's3cret',
    isOwner: req => req.headers.cookie === 'owner' });
  const server = http.createServer(async (req, res) => { if (!(await handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const form = body => ({ method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'owner' }, body: new URLSearchParams(body) });

  // Discovery and challenge.
  const unauth = await fetch(base + '/mcp', { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
  const meta = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  const reg = await (await fetch(base + '/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
  assert.ok(reg.client_id);
  assert.equal((await fetch(base + '/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) })).status, 400);

  // Authorization: password gate, PKCE, allowed redirect only.
  const verifier = 'v'.repeat(50);
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const params = { client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' };
  assert.equal((await fetch(base + '/oauth/authorize?' + new URLSearchParams(params))).status, 401, 'no owner session');
  assert.equal((await fetch(base + '/oauth/authorize?' + new URLSearchParams(params), { headers: { cookie: 'owner' } })).status, 200);
  const csrf = form(params); csrf.headers.origin = 'https://evil.example';
  assert.equal((await fetch(base + '/oauth/authorize', csrf)).status, 401, 'cross-site approve refused');
  const crossFetch = form(params); crossFetch.headers['sec-fetch-site'] = 'cross-site';
  assert.equal((await fetch(base + '/oauth/authorize', crossFetch)).status, 401, 'Sec-Fetch-Site cross-site refused');
  const nullOrigin = form(params); nullOrigin.headers.origin = 'null';
  assert.equal((await fetch(base + '/oauth/authorize', nullOrigin)).status, 401, 'null Origin without Sec-Fetch-Site refused');
  const chrome = form(params); Object.assign(chrome.headers, { origin: 'null', 'sec-fetch-site': 'same-origin' });
  const chromeOk = await fetch(base + '/oauth/authorize', chrome);
  assert.equal(chromeOk.status, 302, 'Chrome under no-referrer: Origin null, Sec-Fetch-Site same-origin');
  assert.equal((await fetch(base + '/oauth/authorize?' + new URLSearchParams(params), { headers: { cookie: 'owner' } })).headers.get('referrer-policy'), 'same-origin');
  assert.equal((await fetch(base + '/oauth/authorize', form({ ...params, redirect_uri: 'https://evil.example/cb' }))).status, 400);
  const ok = await fetch(base + '/oauth/authorize', form(params));
  assert.equal(ok.status, 302);
  const back = new URL(ok.headers.get('location'));
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'xyz');
  const code = back.searchParams.get('code');

  const tokenReq = body => fetch(base + '/oauth/token', form(body));
  assert.equal((await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: 'x'.repeat(50) })).status, 400);
  const tokens = await (await tokenReq({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier })).json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal((await tokenReq({ grant_type: 'refresh_token', refresh_token: tokens.access_token })).status, 400, 'access token is not a refresh token');
  const refreshed = await (await tokenReq({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).json();
  assert.ok(refreshed.access_token);
  const forged = tokens.access_token.slice(0, -2) + (tokens.access_token.endsWith('AA') ? 'BB' : 'AA');
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + forged }, body: '{}' })).status, 401);
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + tokens.refresh_token }, body: '{}' })).status, 401);

  // MCP over Streamable HTTP (JSON responses).
  let id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + refreshed.access_token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    return (await r.json());
  };
  const call = async (name, args) => {
    const r = (await rpc('tools/call', { name, arguments: args })).result;
    return { error: r.isError, value: name === 'brain_wiki' || r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
  };
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  const note = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + refreshed.access_token }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const names = (await rpc('tools/list')).result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['brain_session', 'brain_wiki']);

  assert.equal((await call('brain_wiki', {})).value, 'Index');
  assert.equal((await call('brain_wiki', { page: 'Page.md' })).value, 'Page');
  assert.ok((await call('brain_wiki', { page: '../secret.md' })).error);
  fs.symlinkSync(path.join(vault, 'secret.md'), path.join(vault, 'wiki/link.md'));
  assert.ok((await call('brain_wiki', { page: 'link.md' })).error);

  const started = (await call('brain_session', { action: 'start', title: 'Duet goal' })).value;
  assert.match(started.path, /^raw\/claude-duet\//);
  assert.ok((await call('brain_session', { action: 'save', revision: 'stale', body: 'x' })).error);
  const saved = (await call('brain_session', { action: 'save', revision: started.revision, body: 'Decision' })).value;
  assert.match(fs.readFileSync(path.join(vault, saved.path), 'utf8'), /agent: "claude-duet"[\s\S]*Decision/);
  assert.ok((await call('brain_session', { action: 'save', revision: saved.revision, body: 'y', path: '../wiki/index.md' })).error, 'no caller-chosen path');
  assert.equal(fs.readFileSync(path.join(vault, 'wiki/index.md'), 'utf8'), 'Index');
  assert.deepEqual(fs.readdirSync(path.join(vault, 'raw')), ['claude-duet']);
  fs.rmSync(path.join(vault, saved.path));
  fs.symlinkSync(path.join(vault, 'secret.md'), path.join(vault, saved.path));
  assert.ok((await call('brain_session', { action: 'save', revision: saved.revision, body: 'z' })).error, 'symlinked note refused');
  assert.equal(fs.readFileSync(path.join(vault, 'secret.md'), 'utf8'), 'PRIVATE');
  assert.equal((await rpc('nope')).error.code, -32601);
});

test('MCP connector: grants and the current goal survive a restart; a rotated secret revokes them', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-mcp-restart-')));
  const vault = path.join(dir, 'vault'), state = path.join(dir, 'state');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'wiki/index.md'), 'Index');
  const servers = [];
  t.after(() => { for (const s of servers) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const boot = async secret => {
    const handle = createMcp({ vault, state, secret, isOwner: () => true });
    const server = http.createServer(async (req, res) => { if (!(await handle(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const post = (base, p, body, headers = {}) => fetch(base + p, { method: 'POST', redirect: 'manual', headers, body });
  const call = (base, token, name, args) => post(base, '/mcp', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    { authorization: 'Bearer ' + token }).then(async r => ({ status: r.status, body: r.status === 200 ? await r.json() : null }));

  const before = await boot('secret-a');
  const verifier = 'w'.repeat(50);
  const params = { redirect_uri: REDIRECT, response_type: 'code', code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' };
  const code = new URL((await post(before, '/oauth/authorize', new URLSearchParams(params), { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' })).headers.get('location')).searchParams.get('code');
  const tokens = await (await post(before, '/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }))).json();
  const started = JSON.parse((await call(before, tokens.access_token, 'brain_session', { action: 'start', title: 'Restart goal' })).body.result.content[0].text);
  await call(before, tokens.access_token, 'brain_session', { action: 'save', revision: started.revision, body: 'Before restart' });

  const after = await boot('secret-a');
  const read = await call(after, tokens.access_token, 'brain_session', { action: 'read' });
  assert.equal(read.status, 200, 'access token issued before the restart still works');
  const note = JSON.parse(read.body.result.content[0].text);
  assert.equal(note.title, 'Restart goal');
  assert.match(note.text, /Before restart/);
  assert.equal(note.path, started.path, 'same note, not a new goal');
  const refreshed = await post(after, '/oauth/token', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }));
  assert.equal(refreshed.status, 200, 'refresh token issued before the restart still works');

  const rotated = await boot('secret-b');
  assert.equal((await call(rotated, tokens.access_token, 'brain_wiki', {})).status, 401, 'rotating SETUP_PASSWORD or session.secret revokes the grant');
  assert.equal((await post(rotated, '/oauth/token', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))).status, 400);
});
