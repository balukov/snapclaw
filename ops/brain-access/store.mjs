import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
function safe(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Invalid relative path');
  let target = root;
  if (fs.realpathSync(root) !== path.resolve(root)) throw Error('Root must not be a symlink');
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Error('Symlinks are forbidden');
  }
  return target;
}
function read(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 200_000) throw Error('Unsafe or oversized file');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function atomic(file, text) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

export function createStore(vault, state) {
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const records = safe(vault, 'raw/snapclaw');
  fs.mkdirSync(records, { recursive: true });
  return {
    wiki(page = 'index.md') {
      if (!page.endsWith('.md')) throw Error('Only Markdown wiki pages are readable');
      return read(safe(vault, 'wiki/' + page));
    },
    session(key, args) {
      if (typeof key !== 'string' || !key) throw Error('Host session identity required');
      const mapping = safe(state, hash(key) + '.json');
      let goal = fs.existsSync(mapping) ? JSON.parse(read(mapping)) : null;
      if (args.action === 'start') {
        if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 200) throw Error('Goal title required (max 200 characters)');
        // Repeated start after reconnect is idempotent. A different goal gets a new note.
        if (!goal || goal.title !== args.title) {
          goal = { id: randomUUID(), title: args.title, date: new Date().toISOString().slice(0, 10) };
          atomic(mapping, JSON.stringify(goal));
        }
      }
      if (!goal) throw Error('Start a goal first');
      const slug = goal.title.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 50) || 'session';
      const relative = `raw/snapclaw/${goal.date}-${slug}-${goal.id}.md`;
      const file = safe(vault, relative);
      let text = fs.existsSync(file) ? read(file) : '';
      if (args.action === 'save') {
        if (args.revision !== hash(text)) throw Error('Session changed: read it again and merge');
        if (typeof args.body !== 'string' || !args.body.trim() || args.body.length > 40_000) throw Error('Body required (max 40000 characters)');
        text = `---\ndate: ${goal.date}\nupdated: ${new Date().toISOString()}\nagent: snapclaw\nsession: ${goal.id}\ntitle: ${JSON.stringify(goal.title)}\n---\n\n${args.body.trim()}\n`;
        atomic(file, text);
      } else if (!['start', 'read'].includes(args.action)) throw Error('Unknown session action');
      return { path: relative, title: goal.title, text, revision: hash(text) };
    },
  };
}
