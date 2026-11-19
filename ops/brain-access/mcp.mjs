// Remote MCP endpoint for the Claude connector (claude.ai, Claude Duet).
// Same boundary as the OpenClaw plugin: reads only wiki/, writes only the
// store-chosen note in raw/claude-duet/. Access is OAuth 2.1 (PKCE, dynamic
// registration); the owner approves on the authorize page from a logged-in
// /snapclaw session, so no password is typed there. Tokens are
// stateless HMAC blobs keyed on the server secret, so rotating
// SETUP_PASSWORD or the session secret revokes every grant.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { createStore } from './store.mjs';

const AGENT = 'claude-duet';
// ponytail: fixed callback list; add one here if another Claude client shows up.
const REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
const CLIENT_ID = 'claude-connector';
const TTL = { code: 300, access: 3600, refresh: 30 * 86400 };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  { name: 'brain_wiki', title: 'Read Brain wiki',
    description: 'Read a Brain wiki Markdown page by name relative to wiki/. Start with index.md and follow its [[links]] as "<Name>.md".',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, properties: { page: { type: 'string' } } } },
  { name: 'brain_session', title: 'Save Claude session note',
    description: 'Record the current goal in Brain (save-session). start with the goal title, read the note, then save the merged Markdown body (sections Согласовано, Сделано, Открыто, Следующий шаг; no frontmatter) with the returned revision. Set status paused or done only when the owner switches goals or confirms. Start a different title only when the owner switches goals. The server chooses the path.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['start', 'read', 'save'] }, title: { type: 'string', maxLength: 200 },
      body: { type: 'string', maxLength: 40000 }, revision: { type: 'string' },
      status: { type: 'string', enum: ['active', 'paused', 'done'] } } } },
];

const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem">${body}`;
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 1_000_000) throw Error('Body too large'); chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };

export function createMcp({ vault, state, secret, isOwner }) {
  // Lazy: the vault may not exist yet when the server boots.
  let store;
  const sign = data => createHmac('sha256', secret).update('brain-mcp:' + data).digest('base64url');
  const issue = (t, extra = {}) => {
    const data = Buffer.from(JSON.stringify({ t, exp: Math.floor(Date.now() / 1000) + TTL[t], ...extra })).toString('base64url');
    return data + '.' + sign(data);
  };
  const verify = (token, t) => {
    const [data, mac] = String(token || '').split('.');
    if (!data || !mac) return null;
    const a = Buffer.from(mac), b = Buffer.from(sign(data));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const claims = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return claims.t === t && claims.exp > Date.now() / 1000 ? claims : null;
  };
  const pair = () => ({ access_token: issue('access'), token_type: 'Bearer', expires_in: TTL.access, refresh_token: issue('refresh') });

  const authorizeForm = q => page('Brain connector', `<h1>Connect Claude to Brain</h1>
<p>Claude will read <code>wiki/</code> and write session notes to <code>raw/${AGENT}/</code>.</p>
<form method="post" action="/oauth/authorize">${['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type']
    .map(k => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? '')}">`).join('')}
<p><b>Only allow if you just added this connector yourself.</b> Anyone can send you this link; allowing it grants Brain access to whoever started it.</p>
<button>Allow</button></form>`);

  function callTool(name, args = {}) {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) throw Error('Unknown tool');
    for (const key of Object.keys(args)) if (!Object.hasOwn(tool.inputSchema.properties, key)) throw Error('Unexpected argument: ' + key);
    store ??= createStore(vault, state, AGENT);
    return name === 'brain_wiki' ? store.wiki(args.page) : store.session(AGENT, args);
  }
  function rpc(msg) {
    const ok = result => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize': return ok({ protocolVersion: PROTOCOLS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} }, serverInfo: { name: 'snapclaw-brain', version: '1.0.0' } });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call':
        try {
          const value = callTool(msg.params?.name, msg.params?.arguments);
          return ok({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
        } catch (err) { return ok({ isError: true, content: [{ type: 'text', text: err.message }] }); }
      default: return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'Method not found' } };
    }
  }

  // Returns true when the request was one of ours.
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = `${req.method} ${url.pathname}`;
    const o = `https://${req.headers.host}`;
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, { resource: o + '/mcp', authorization_servers: [o], bearer_methods_supported: ['header'] });
    } else if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
      json(res, 200, { issuer: o, authorization_endpoint: o + '/oauth/authorize', token_endpoint: o + '/oauth/token',
        registration_endpoint: o + '/oauth/register', response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'] });
    } else if (route === 'POST /oauth/register') {
      let uris;
      try { uris = JSON.parse(await body(req)).redirect_uris; } catch {}
      if (!Array.isArray(uris) || !uris.length || !uris.every(u => REDIRECTS.includes(u))) return json(res, 400, { error: 'invalid_redirect_uri' }), true;
      json(res, 201, { client_id: CLIENT_ID, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    } else if (url.pathname === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      const q = req.method === 'POST' ? new URLSearchParams(await body(req)) : url.searchParams;
      const send = (status, html) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); };
      if (!REDIRECTS.includes(q.get('redirect_uri')) || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return send(400, page('Brain connector', '<p>Invalid authorization request.</p>')), true;
      }
      // Approval needs the owner's setup session. The cookie is SameSite=Lax, so a
      // cross-site POST arrives without it; the Origin check covers old browsers.
      const sameSite = !req.headers.origin || req.headers.origin === o;
      if (!isOwner(req) || (req.method === 'POST' && !sameSite)) {
        return send(401, page('Brain connector', '<p>Log in at <a href="/snapclaw">/snapclaw</a> in this browser, then reload this page.</p>')), true;
      }
      if (req.method === 'GET') return send(200, authorizeForm(q)), true;
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', issue('code', { challenge: q.get('code_challenge'), redirect_uri: q.get('redirect_uri') }));
      if (q.get('state')) back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { location: back.href, 'cache-control': 'no-store' }); res.end();
    } else if (route === 'POST /oauth/token') {
      const q = new URLSearchParams(await body(req));
      if (q.get('grant_type') === 'authorization_code') {
        // ponytail: a code stays valid for its 5 minutes (stateless); PKCE binds it to the verifier holder.
        const c = verify(q.get('code'), 'code');
        const pkce = c && createHash('sha256').update(q.get('code_verifier') ?? '').digest('base64url');
        if (!c || c.redirect_uri !== q.get('redirect_uri') || pkce !== c.challenge) return json(res, 400, { error: 'invalid_grant' }), true;
        json(res, 200, pair());
      } else if (q.get('grant_type') === 'refresh_token') {
        if (!verify(q.get('refresh_token'), 'refresh')) return json(res, 400, { error: 'invalid_grant' }), true;
        json(res, 200, pair());
      } else json(res, 400, { error: 'unsupported_grant_type' });
    } else if (url.pathname === '/mcp') {
      const token = (req.headers.authorization ?? '').match(/^Bearer (\S+)$/)?.[1];
      if (!verify(token, 'access')) {
        return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${o}/.well-known/oauth-protected-resource"` }), true;
      }
      // Stateless server: no SSE stream, no session to delete.
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' }), true;
      let msg;
      try { msg = JSON.parse(await body(req)); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), true; }
      // Notifications (no id) get 202. No batches: MCP 2025-06-18 dropped them.
      if (msg?.id === undefined) { res.writeHead(202); res.end(); return true; }
      json(res, 200, rpc(msg));
    } else return false;
    return true;
  };
}
