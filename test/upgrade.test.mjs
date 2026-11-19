import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseJsonTail,
  needsMigration,
  countAuthProfiles,
  dashboardFragment,
  migrationAction,
  openclawVersion,
  snapshotState,
} from "../dist/upgrade.js";

const WARNING =
  "Installed Gateway service state and config paths could not be verified. Inspect the service environment with `openclaw gateway status --deep` before repairing plugin state.\n";

test("needsMigration: due when the marker is missing or differs, not when equal or version unknown", () => {
  assert.equal(needsMigration(null, "OpenClaw 2026.9.2 (3928bad)"), true);
  assert.equal(needsMigration("OpenClaw 2026.5.27", "OpenClaw 2026.9.2 (3928bad)"), true);
  assert.equal(needsMigration("OpenClaw 2026.9.2 (3928bad)\n", "OpenClaw 2026.9.2 (3928bad)"), false);
  assert.equal(needsMigration(null, ""), false);
});

test("countAuthProfiles: tolerates the CLI warning prefix and non-JSON output", () => {
  const one = WARNING + JSON.stringify({ agentId: "main", provider: "openai", profiles: [{ id: "openai:me@example.com" }] });
  const none = JSON.stringify({ agentId: "main", provider: null, profiles: [] });
  assert.equal(countAuthProfiles(one), 1);
  assert.equal(countAuthProfiles(none), 0);
  assert.equal(countAuthProfiles("models auth list requires a running gateway"), 0);
  assert.equal(parseJsonTail("no json here"), null);
  assert.equal(countAuthProfiles(JSON.stringify({ agentId: "main" })), 0);
  assert.equal(
    countAuthProfiles("warning: expected shape is {profiles: [...]}\n" + JSON.stringify({ profiles: [{ id: "openai:me" }] })),
    1,
  );
});

test("dashboardFragment: returns the bootstrap fragment only when the token is present", () => {
  const ok = WARNING + JSON.stringify({
    ok: true,
    url: "http://127.0.0.1:18789/",
    browserUrl: "http://127.0.0.1:18789/#bootstrapToken=3D0l08uTl6G9nM4z&bootstrapProfile=owner",
    browserBootstrapExpiresAtMs: 1788674629285,
  });
  assert.equal(dashboardFragment(ok), "#bootstrapToken=3D0l08uTl6G9nM4z&bootstrapProfile=owner");
  assert.equal(dashboardFragment(JSON.stringify({ ok: true, browserUrl: "http://127.0.0.1:18789/" })), null);
  assert.equal(dashboardFragment("Gateway not reachable"), null);
});

test("migrationAction: forward or unknown versions migrate, an older OpenClaw is a downgrade", () => {
  assert.deepEqual(openclawVersion("OpenClaw 2026.9.2 (3928bad)"), [2026, 9, 2]);
  assert.equal(openclawVersion("garbage"), null);
  assert.equal(migrationAction("OpenClaw 2026.9.2 (3928bad)", "OpenClaw 2026.9.2 (3928bad)"), "none");
  assert.equal(migrationAction(null, ""), "none");
  assert.equal(migrationAction(null, "OpenClaw 2026.9.2 (3928bad)"), "migrate");
  assert.equal(migrationAction("OpenClaw 2026.5.27", "OpenClaw 2026.9.2 (3928bad)"), "migrate");
  assert.equal(migrationAction("OpenClaw 2026.9.2 (3928bad)", "OpenClaw 2026.10.1 (aaaaaaa)"), "migrate");
  assert.equal(migrationAction("OpenClaw 2026.9.2 (3928bad)", "OpenClaw 2026.9.2 (1111111)"), "migrate");
  assert.equal(migrationAction("something odd", "OpenClaw 2026.9.2"), "migrate");
  assert.equal(migrationAction("OpenClaw 2026.9.2 (3928bad)", "OpenClaw 2026.5.27"), "downgrade");
  assert.equal(migrationAction("OpenClaw 2026.10.1", "OpenClaw 2026.9.2"), "downgrade");
});

test("snapshotState: copies gateway state but not the vault, browser or older snapshots; one per version pair; keeps two", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapclaw-snapshot-"));
  try {
    fs.mkdirSync(path.join(dir, "state"), { recursive: true });
    fs.mkdirSync(path.join(dir, "workspace/wiki"), { recursive: true });
    fs.mkdirSync(path.join(dir, "browser/openclaw"), { recursive: true });
    fs.writeFileSync(path.join(dir, "openclaw.json"), '{"v":5}');
    fs.writeFileSync(path.join(dir, "openclaw-version"), "OpenClaw 2026.5.27");
    fs.writeFileSync(path.join(dir, "state/openclaw.sqlite"), "db");
    fs.writeFileSync(path.join(dir, "workspace/wiki/index.md"), "vault");
    fs.symlinkSync(path.join(dir, "workspace"), path.join(dir, "workspace-link"));
    fs.mkdirSync(path.join(dir, "brain-sessions-claude-duet"));
    fs.writeFileSync(path.join(dir, "brain-access-enabled"), "");
    fs.writeFileSync(path.join(dir, "session.secret"), "s");

    const snap = snapshotState(dir, "OpenClaw 2026.5.27", "OpenClaw 2026.9.2 (3928bad)");
    assert.match(path.basename(snap), /^pre-migration-.+-2026\.5\.27-to-2026\.9\.2$/);
    assert.equal(fs.readFileSync(path.join(snap, "openclaw.json"), "utf8"), '{"v":5}');
    assert.equal(fs.readFileSync(path.join(snap, "openclaw-version"), "utf8"), "OpenClaw 2026.5.27");
    assert.equal(fs.readFileSync(path.join(snap, "state/openclaw.sqlite"), "utf8"), "db");
    assert.equal(fs.existsSync(path.join(snap, "workspace")), false);
    assert.equal(fs.existsSync(path.join(snap, "browser")), false);
    assert.equal(fs.existsSync(path.join(snap, "backups")), false);
    for (const own of ["brain-sessions-claude-duet", "brain-access-enabled", "session.secret"]) {
      assert.equal(fs.existsSync(path.join(snap, own)), false, `${own} is SnapClaw state, never restored`);
    }
    assert.equal(fs.lstatSync(path.join(snap, "workspace-link")).isSymbolicLink(), true, "links are copied, not followed");

    fs.writeFileSync(path.join(dir, "openclaw.json"), '{"v":"half-migrated"}');
    assert.equal(snapshotState(dir, "OpenClaw 2026.5.27", "OpenClaw 2026.9.2"), snap, "a retried migration keeps the first snapshot");
    assert.equal(fs.readFileSync(path.join(snap, "openclaw.json"), "utf8"), '{"v":5}');

    const cut = path.join(dir, "backups", ".partial-pre-migration-2026-01-01T00-00-00-000Z-2026.9.2-to-2026.10.1");
    fs.mkdirSync(cut);
    fs.writeFileSync(path.join(cut, "openclaw.json"), "{");
    const fresh = snapshotState(dir, "OpenClaw 2026.9.2", "OpenClaw 2026.10.1");
    assert.notEqual(path.basename(fresh), path.basename(cut), "a copy cut short is not reused");
    assert.equal(fs.readFileSync(path.join(fresh, "openclaw.json"), "utf8"), '{"v":"half-migrated"}');
    assert.equal(fs.existsSync(cut), false, "leftover partial copies are cleared");

    snapshotState(dir, "OpenClaw 2026.10.1", "OpenClaw 2026.11.1");
    const kept = fs.readdirSync(path.join(dir, "backups")).sort();
    assert.equal(kept.length, 2);
    assert.match(kept[0], /2026\.9\.2-to-2026\.10\.1$/);
    assert.match(kept[1], /2026\.10\.1-to-2026\.11\.1$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
