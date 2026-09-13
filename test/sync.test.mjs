import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SETUP_PASSWORD = "test-password";
process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "snapclaw-sync-test-"));

const { nextBackoffMs } = await import("../dist/sync.js");

test("nextBackoffMs: 5s doubling to a 60s cap, negative attempts start at 5s", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 9].map(nextBackoffMs),
    [5000, 10000, 20000, 40000, 60000, 60000, 60000],
  );
  assert.equal(nextBackoffMs(-1), 5000);
});
