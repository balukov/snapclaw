import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fakeBin } from "./fixtures/bin.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "snapclaw-sync-test-"));
process.env.SETUP_PASSWORD = "test-password";
process.env.OPENCLAW_STATE_DIR = root;
process.env.PATH = fakeBin(root);
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const { nextBackoffMs, ensure, stop, state } = await import("../dist/sync.js");

const pidFile = path.join(root, "fake-ob.pid");
const obPid = () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : null);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(100);
  }
  return false;
}

test("nextBackoffMs: 5s doubling to a 60s cap, negative attempts start at 5s", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map(nextBackoffMs),
    [5000, 10000, 20000, 40000, 60000, 60000, 60000],
  );
  assert.equal(nextBackoffMs(-1), 5000);
});

test("sync: not set up means nothing is started", async () => {
  process.env.FAKE_OB_CONFIGURED = "0";
  assert.equal(await ensure(), "not-configured");
  assert.equal(obPid(), null);
});

test("sync: resumes after the client dies, stays down after stop, comes back on the next ensure", async (t) => {
  process.env.FAKE_OB_CONFIGURED = "1";
  t.after(() => stop());

  assert.equal(await ensure(), "running");
  assert.ok(await until(() => obPid() && alive(obPid()), 5000), "client started");
  const first = obPid();

  process.kill(first, "SIGKILL");
  assert.ok(await until(() => obPid() !== first && alive(obPid()), 8000), "client restarted after the 5s backoff");
  assert.equal(state(), "running");

  const second = obPid();
  await stop();
  assert.equal(alive(second), false);
  assert.equal(state(), "configured");
  await sleep(5500);
  assert.equal(obPid(), second, "no restart after a deliberate stop");

  assert.equal(await ensure(), "running", "a new boot (or the panel's Check) starts it again");
  assert.ok(await until(() => obPid() !== second && alive(obPid()), 5000));
});
