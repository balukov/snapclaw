import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function telegramPairingCount(dbPath: string): number {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("select count(*) as n from channel_pairing_allow_entries where channel_key = ?")
        .get("telegram") as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

export function channelsReadyFlag(stateDir: string): string {
  return path.join(stateDir, ".channels-ready");
}

export function markChannelsReadyOnVolume(stateDir: string): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(channelsReadyFlag(stateDir), "1");
  } catch {}
}

// The flag outlives OpenClaw schema changes; the pairing table is read only to
// adopt volumes paired before the flag existed.
export function channelsReadyOnVolume(stateDir: string, botTokenSet: boolean): boolean {
  if (!botTokenSet) {
    try {
      fs.unlinkSync(channelsReadyFlag(stateDir));
    } catch {}
    return false;
  }
  if (fs.existsSync(channelsReadyFlag(stateDir))) return true;
  if (telegramPairingCount(path.join(stateDir, "state", "openclaw.sqlite")) > 0) {
    markChannelsReadyOnVolume(stateDir);
    return true;
  }
  return false;
}
