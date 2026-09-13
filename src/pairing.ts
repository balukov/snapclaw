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
