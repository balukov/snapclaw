// Stand-in for the obsidian-headless CLI. FAKE_OB_CONFIGURED=1 makes
// sync-status succeed; `sync --continuous` stays up until signalled.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const state = process.env.OPENCLAW_STATE_DIR;
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `ob ${args.join(' ')}\n`);

if (args[0] === 'sync-status') {
  process.exit(process.env.FAKE_OB_CONFIGURED === '1' ? 0 : 1);
} else if (args[0] === 'sync' && args.includes('--continuous')) {
  fs.writeFileSync(path.join(state, 'fake-ob.pid'), String(process.pid));
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
}
