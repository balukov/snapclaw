// Puts `openclaw` and `ob` stand-ins on a fresh bin dir; returns a PATH value.
import fs from 'node:fs';
import path from 'node:path';

export function fakeBin(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, script] of [['openclaw', 'fake-openclaw.mjs'], ['ob', 'fake-ob.mjs']]) {
    const target = new URL(script, import.meta.url).pathname;
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" --no-warnings "${target}" "$@"\n`, { mode: 0o755 });
  }
  return `${bin}${path.delimiter}${process.env.PATH}`;
}
