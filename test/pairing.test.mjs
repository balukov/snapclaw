import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { telegramPairingCount } from "../dist/pairing.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapclaw-pairing-"));

function dbWith(rows) {
  const p = path.join(dir, `${Math.random().toString(36).slice(2)}.sqlite`);
  const db = new DatabaseSync(p);
  db.exec("create table channel_pairing_allow_entries (channel_key text, account_id text, entry text, sort_order integer, updated_at integer)");
  for (const [channel, entry] of rows) {
    db.prepare("insert into channel_pairing_allow_entries values (?, 'default', ?, 0, 0)").run(channel, entry);
  }
  db.close();
  return p;
}

test("telegramPairingCount: counts telegram allow entries only", () => {
  assert.equal(telegramPairingCount(dbWith([["telegram", "123775322"]])), 1);
  assert.equal(telegramPairingCount(dbWith([["telegram", "1"], ["telegram", "2"], ["discord", "3"]])), 2);
  assert.equal(telegramPairingCount(dbWith([["discord", "3"]])), 0);
  assert.equal(telegramPairingCount(dbWith([])), 0);
});

test("telegramPairingCount: missing file or missing table is zero, not a throw", () => {
  assert.equal(telegramPairingCount(path.join(dir, "nope.sqlite")), 0);
  const p = path.join(dir, "empty.sqlite");
  new DatabaseSync(p).close();
  assert.equal(telegramPairingCount(p), 0);
});
