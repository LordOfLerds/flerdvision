import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runScheduleCli } from "../dist/cli/schedule-cli.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-schedule-cli-"));
  const path = join(dir, "flerdvision.json");
  const spec = {
    schemaVersion: 1,
    workspace: { id: "cli-test", name: "CLI Test", ownerEmail: "test@example.com", timezone: "Europe/Vienna", runtimeRoot: join(dir, "runtime") },
    source: { kind: "local_folder", root: join(dir, "source"), structure: "auto", activation: "IMPORT_BACKLOG", maxDepth: 4 },
    channels: [{
      key: "instagram-test", name: "Instagram Test", platform: "instagram", handle: "test",
      formats: [{ type: "reel", times: ["12:00", "19:00"], sourceMatch: [], captionTemplate: "{filenameText}", hashtags: [], verificationMarker: false, requirement: "REQUIRED", settings: { commentsEnabled: true, shareToFeed: true, crosspostFacebook: false } }]
    }],
    notifications: { onSuccess: "daily_summary", onBlocked: "immediate", onUncertain: "immediate" },
    privateTest: { enabled: false, accountPrivate: false, approvedFollowers: 0, contactsSyncOff: false, crossPostingOff: false, autoCleanup: false }
  };
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
  return { dir, path };
}

test("CLI schedule show and add route through the same schedule service and compiler hook", async () => {
  const f = fixture();
  const output = [];
  const applied = [];
  try {
    await runScheduleCli("schedule", ["show", "--spec", f.path], f.path, {
      output: (line) => output.push(line),
      applier: { apply: (path) => applied.push(path) }
    });
    assert.equal(applied.length, 0);
    assert.match(output.join("\n"), /CLI Test · Instagram Test · reel · 12:00, 19:00/);

    output.length = 0;
    await runScheduleCli("schedule", ["add", "instagram", "16:00", "--spec", f.path], f.path, {
      output: (line) => output.push(line),
      applier: { apply: (path) => applied.push(path) }
    });
    assert.equal(applied.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).channels[0].formats[0].times, ["12:00", "16:00", "19:00"]);
    assert.match(output.join("\n"), /CLI Test · Instagram Test/);
    assert.match(output.join("\n"), /Bereits materialisierte heutige Posts bleiben/);
    assert.match(output.join("\n"), /\/pause stoppt fällige Posts sofort/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("CLI capacity expands without moving existing times and malformed commands fail closed", async () => {
  const f = fixture();
  try {
    await runScheduleCli("capacity", ["instagram", "3", "--spec", f.path], f.path, { applier: { apply() {} }, output() {} });
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).channels[0].formats[0].times, ["12:00", "15:00", "19:00"]);
    await assert.rejects(() => runScheduleCli("schedule", ["remove", "instagram"], f.path, { applier: { apply() {} }, output() {} }), /Usage/);
    await assert.rejects(() => runScheduleCli("capacity", ["instagram", "nope"], f.path, { applier: { apply() {} }, output() {} }), /Kapazität/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("canonical product CLI advertises schedule/capacity but no second schedule implementation", () => {
  const source = readFileSync(new URL("../src/cli/flerdvision.ts", import.meta.url).pathname, "utf8");
  const adapter = readFileSync(new URL("../src/cli/schedule-cli.ts", import.meta.url).pathname, "utf8");
  assert.match(source, /runScheduleCli/);
  assert.match(source, /schedule add/);
  assert.match(source, /capacity <kanal/);
  assert.doesNotMatch(source, /writeFileSync\(/);
  assert.match(adapter, /new ScheduleCommandService/);
});
