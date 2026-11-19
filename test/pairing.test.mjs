import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { telegramPairingCount, channelsReadyOnVolume, markChannelsReadyOnVolume } from "../dist/pairing.js";

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

function volume({ pairedInDb = false, flag = false } = {}) {
  const v = fs.mkdtempSync(path.join(dir, "vol-"));
  fs.mkdirSync(path.join(v, "state"));
  const db = new DatabaseSync(path.join(v, "state", "openclaw.sqlite"));
  db.exec("create table channel_pairing_allow_entries (channel_key text, account_id text, entry text, sort_order integer, updated_at integer)");
  if (pairedInDb) db.exec("insert into channel_pairing_allow_entries values ('telegram', 'default', '42', 0, 0)");
  db.close();
  if (flag) markChannelsReadyOnVolume(v);
  return v;
}

test("channelsReadyOnVolume: a pairing made before the flag existed is adopted and written to the flag", () => {
  const v = volume({ pairedInDb: true });
  assert.equal(fs.existsSync(path.join(v, ".channels-ready")), false);
  assert.equal(channelsReadyOnVolume(v, true), true);
  assert.equal(fs.existsSync(path.join(v, ".channels-ready")), true);
});

test("channelsReadyOnVolume: the flag survives an upgrade that renames or drops OpenClaw's pairing table", () => {
  const v = volume({ pairedInDb: true });
  assert.equal(channelsReadyOnVolume(v, true), true);
  const db = new DatabaseSync(path.join(v, "state", "openclaw.sqlite"));
  db.exec("alter table channel_pairing_allow_entries rename to pairing_allow_v2");
  db.close();
  assert.equal(telegramPairingCount(path.join(v, "state", "openclaw.sqlite")), 0);
  assert.equal(channelsReadyOnVolume(v, true), true);
  fs.rmSync(path.join(v, "state"), { recursive: true });
  assert.equal(channelsReadyOnVolume(v, true), true, "flag alone is enough after a restart");
});

test("channelsReadyOnVolume: a pairing approved after the upgrade (flag only) counts; no pairing does not", () => {
  assert.equal(channelsReadyOnVolume(volume({ flag: true }), true), true);
  assert.equal(channelsReadyOnVolume(volume(), true), false);
});

test("channelsReadyOnVolume: removing the bot token clears the flag", () => {
  const v = volume({ flag: true });
  assert.equal(channelsReadyOnVolume(v, false), false);
  assert.equal(fs.existsSync(path.join(v, ".channels-ready")), false);
  assert.equal(channelsReadyOnVolume(v, true), false);
});
