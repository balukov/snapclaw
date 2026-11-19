// Stand-in for the OpenClaw CLI in recovery tests. Behaviour comes from env:
// FAKE_OPENCLAW_VERSION, FAKE_LOG (one line per call). doctor --fix "migrates"
// by stamping openclaw.json and renaming the pairing table, as a schema change would.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const version = process.env.FAKE_OPENCLAW_VERSION ?? 'OpenClaw 0.0.0';
const state = process.env.OPENCLAW_STATE_DIR;
const log = line => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, `${line}\n`);
const db = () => new DatabaseSync(path.join(state, 'state', 'openclaw.sqlite'));

log(`${version} ${args.join(' ')}`);

if (args[0] === '--version') {
  console.log(version);
} else if (args[0] === 'doctor') {
  const file = path.join(state, 'openclaw.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.meta = { ...cfg.meta, migratedBy: version };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  if (process.env.FAKE_DOCTOR_RENAMES_PAIRING) {
    const d = db();
    try { d.exec('alter table channel_pairing_allow_entries rename to pairing_allow_v2'); } catch {}
    d.close();
  }
} else if (args[0] === 'gateway' && args[1] === 'run') {
  const port = Number(args[args.indexOf('--port') + 1]);
  fs.writeFileSync(path.join(state, 'fake-gateway.pid'), String(process.pid));
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end(); });
  server.listen(port, '127.0.0.1');
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
} else if (args[0] === 'models') {
  console.log(JSON.stringify({ agentId: 'main', provider: 'openai', profiles: [{ id: 'openai:fixture' }] }));
} else if (args[0] === 'pairing' && args[1] === 'approve') {
  const d = db();
  d.exec('create table if not exists channel_pairing_allow_entries (channel_key text, account_id text, entry text, sort_order integer, updated_at integer)');
  d.prepare("insert into channel_pairing_allow_entries values (?, 'default', ?, 0, 0)").run(args[2], args[3]);
  d.close();
}
