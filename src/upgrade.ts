import fs from "node:fs";
import path from "node:path";

export function parseJsonTail(output: string): unknown {
  let start = output.indexOf("{");
  while (start >= 0) {
    try {
      return JSON.parse(output.slice(start));
    } catch {
      start = output.indexOf("{", start + 1);
    }
  }
  return null;
}

export function needsMigration(marker: string | null, current: string): boolean {
  const cur = current.trim();
  if (!cur) return false;
  return (marker ?? "").trim() !== cur;
}

export function countAuthProfiles(output: string): number {
  const parsed = parseJsonTail(output) as { profiles?: unknown } | null;
  return Array.isArray(parsed?.profiles) ? parsed.profiles.length : 0;
}

export function dashboardFragment(output: string): string | null {
  const parsed = parseJsonTail(output) as { browserUrl?: unknown } | null;
  if (typeof parsed?.browserUrl !== "string") return null;
  let hash: string;
  try {
    hash = new URL(parsed.browserUrl).hash;
  } catch {
    return null;
  }
  return hash.includes("bootstrapToken=") ? hash : null;
}

export type MigrationAction = "none" | "migrate" | "downgrade";

export function openclawVersion(text: string | null): number[] | null {
  const m = /(\d{4})\.(\d{1,2})\.(\d{1,3})/.exec(text ?? "");
  return m ? m.slice(1).map(Number) : null;
}

export function migrationAction(marker: string | null, current: string): MigrationAction {
  if (!needsMigration(marker, current)) return "none";
  const from = openclawVersion(marker);
  const to = openclawVersion(current);
  if (from && to) {
    for (let i = 0; i < 3; i++) {
      if (to[i] < from[i]) return "downgrade";
      if (to[i] > from[i]) break;
    }
  }
  return "migrate";
}

export const SNAPSHOT_DIR = "backups";
export const SNAPSHOT_PREFIX = "pre-migration-";
const PARTIAL_PREFIX = ".partial-";
// Skipped: the vault (Obsidian Sync carries it), regenerable caches, older
// snapshots, and SnapClaw's own state that OpenClaw never migrates. Restoring
// that last group would revoke connector grants or rewind Brain session notes.
const SNAPSHOT_SKIP = new Set([
  "workspace",
  SNAPSHOT_DIR,
  "browser",
  "npm",
  "session.secret",
  "setup-password",
  "gateway.token",
]);
const skipInSnapshot = (entry: string) => SNAPSHOT_SKIP.has(entry) || entry.startsWith("brain-");

const STAMP = /^pre-migration-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/;

// Names sort by creation: the stamp never repeats or goes backwards.
function nextStamp(root: string): string {
  let ms = Date.now();
  try {
    for (const f of fs.readdirSync(root)) {
      const m = STAMP.exec(f);
      if (m) ms = Math.max(ms, Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) + 1);
    }
  } catch {}
  return new Date(ms).toISOString().replace(/[:.]/g, "-");
}

export function snapshotState(
  stateDir: string,
  fromVersion: string | null,
  toVersion: string,
  keep = 2,
): string | null {
  const root = path.join(stateDir, SNAPSHOT_DIR);
  const from = openclawVersion(fromVersion)?.join(".") ?? "unknown";
  const to = openclawVersion(toVersion)?.join(".") ?? "unknown";
  const suffix = `-${from}-to-${to}`;
  try {
    const earlier = fs.readdirSync(root).find((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith(suffix));
    if (earlier) return path.join(root, earlier);
  } catch {}
  const name = SNAPSHOT_PREFIX + nextStamp(root) + suffix;
  const dest = path.join(root, name);
  // Copied under a partial name and renamed when complete, so a copy cut short
  // by a container kill is never mistaken for a usable snapshot.
  const partial = path.join(root, PARTIAL_PREFIX + name);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(root)) {
      if (f.startsWith(PARTIAL_PREFIX)) fs.rmSync(path.join(root, f), { recursive: true, force: true });
    }
    fs.mkdirSync(partial, { mode: 0o700 });
    for (const entry of fs.readdirSync(stateDir)) {
      if (skipInSnapshot(entry)) continue;
      fs.cpSync(path.join(stateDir, entry), path.join(partial, entry), {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => {
          const st = fs.lstatSync(src);
          return st.isFile() || st.isDirectory() || st.isSymbolicLink();
        },
      });
    }
    fs.renameSync(partial, dest);
  } catch (err) {
    console.error(`[upgrade] state snapshot failed: ${(err as Error).message}`);
    fs.rmSync(partial, { recursive: true, force: true });
    return null;
  }
  const old = fs
    .readdirSync(root)
    .filter((f) => f.startsWith(SNAPSHOT_PREFIX))
    .sort();
  for (const f of old.slice(0, Math.max(0, old.length - keep))) {
    fs.rmSync(path.join(root, f), { recursive: true, force: true });
  }
  return dest;
}
