import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScheduleCommandError, ScheduleCommandService } from "../dist/application/schedule-commands.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

function rawSpec(formats = [{
  type: "reel",
  times: ["12:00", "19:00"],
  frequencyPerDay: 2,
  sourceMatch: ["instagram"],
  captionTemplate: "{filenameText}",
  hashtags: [],
  verificationMarker: false,
  requirement: "REQUIRED",
  settings: { commentsEnabled: true, shareToFeed: true, crosspostFacebook: false }
}]) {
  return {
    schemaVersion: 1,
    workspace: { id: "test", name: "Test", ownerEmail: "test@example.com", timezone: "Europe/Vienna", runtimeRoot: "runtime" },
    source: { kind: "local_folder", root: "/tmp/source", structure: "auto", activation: "IMPORT_BACKLOG", maxDepth: 4 },
    channels: [{ key: "instagram-test", name: "Instagram Test", platform: "instagram", handle: "test", formats }],
    notifications: { onSuccess: "daily_summary", onBlocked: "immediate", onUncertain: "immediate" },
    privateTest: { enabled: false, accountPrivate: false, approvedFollowers: 0, contactsSyncOff: false, crossPostingOff: false, autoCleanup: false }
  };
}

function fixture(spec = rawSpec()) {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-schedule-"));
  const path = join(dir, "flerdvision.json");
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
  return { dir, path };
}

test("capacity expansion preserves existing slots and all schedule writes stay canonical", async () => {
  const runtime = fixture();
  const applied = [];
  try {
    const service = new ScheduleCommandService(runtime.path, {
      apply(path) { applied.push(parseWorkspaceSpec(JSON.parse(readFileSync(path, "utf8")))); }
    });
    assert.deepEqual(service.show().map((entry) => [entry.customerKey, entry.customerName, entry.platform, entry.format, entry.times, entry.capacity]), [
      ["default", "Test", "instagram", "reel", ["12:00", "19:00"], 2]
    ]);

    const expanded = await service.capacity("instagram", 3);
    assert.equal(expanded.customerName, "Test");
    assert.deepEqual(expanded.beforeTimes, ["12:00", "19:00"]);
    assert.deepEqual(expanded.times, ["12:00", "15:00", "19:00"]);
    assert.equal(expanded.capacity, 3);
    let raw = JSON.parse(readFileSync(runtime.path, "utf8"));
    assert.deepEqual(raw.channels[0].formats[0].times, ["12:00", "15:00", "19:00"]);
    assert.equal(raw.channels[0].formats[0].frequencyPerDay, 3, "legacy frequency field stays consistent when present");

    await service.add("instagram", "16:00");
    await service.remove("instagram", "15:00");
    const set = await service.set("instagram", ["20:00", "10:00", "15:00"]);
    assert.deepEqual(set.times, ["10:00", "15:00", "20:00"]);
    raw = JSON.parse(readFileSync(runtime.path, "utf8"));
    assert.deepEqual(raw.channels[0].formats[0].times, ["10:00", "15:00", "20:00"]);
    assert.equal(applied.length, 4);
  } finally { rmSync(runtime.dir, { recursive: true, force: true }); }
});

test("explicit customer name is projected without changing mutation semantics", async () => {
  const spec = rawSpec();
  spec.customers = [{ key: "kunde-a", name: "Kunde A" }];
  spec.channels[0].customerKey = "kunde-a";
  const runtime = fixture(spec);
  try {
    const service = new ScheduleCommandService(runtime.path);
    const [shown] = service.show();
    assert.equal(shown.customerKey, "kunde-a");
    assert.equal(shown.customerName, "Kunde A");
    const changed = await service.add("instagram", "16:00");
    assert.equal(changed.customerName, "Kunde A");
    assert.deepEqual(changed.times, ["12:00", "16:00", "19:00"]);
  } finally { rmSync(runtime.dir, { recursive: true, force: true }); }
});

test("capacity never deletes hidden slots and the last slot cannot disappear", async () => {
  const runtime = fixture();
  try {
    const service = new ScheduleCommandService(runtime.path);
    const before = readFileSync(runtime.path, "utf8");
    await assert.rejects(() => service.capacity("instagram", 1), ScheduleCommandError);
    assert.equal(readFileSync(runtime.path, "utf8"), before);

    await service.set("instagram", ["12:00"]);
    const one = readFileSync(runtime.path, "utf8");
    await assert.rejects(() => service.remove("instagram", "12:00"), /letzte Slot/);
    assert.equal(readFileSync(runtime.path, "utf8"), one);
  } finally { rmSync(runtime.dir, { recursive: true, force: true }); }
});

test("multi-format channels require an explicit format instead of mutating both", async () => {
  const second = {
    type: "story",
    times: ["11:00"],
    sourceMatch: ["story"],
    captionTemplate: "{filenameText}",
    hashtags: [],
    verificationMarker: false,
    requirement: "OPTIONAL",
    settings: { commentsEnabled: true }
  };
  const runtime = fixture(rawSpec([rawSpec().channels[0].formats[0], second]));
  try {
    const service = new ScheduleCommandService(runtime.path);
    await assert.rejects(() => service.add("instagram", "16:00"), /mehrere Formate/);
    const changed = await service.add("instagram/reel", "16:00");
    assert.deepEqual(changed.times, ["12:00", "16:00", "19:00"]);
    const shown = service.show();
    assert.deepEqual(shown.find((entry) => entry.format === "story").times, ["11:00"]);
  } finally { rmSync(runtime.dir, { recursive: true, force: true }); }
});

test("failed compile rolls the exact canonical spec back and reapplies the old version", async () => {
  const runtime = fixture();
  const original = readFileSync(runtime.path, "utf8");
  let calls = 0;
  try {
    const service = new ScheduleCommandService(runtime.path, {
      apply(path) {
        calls += 1;
        parseWorkspaceSpec(JSON.parse(readFileSync(path, "utf8")));
        if (calls === 1) throw new Error("compiler unavailable");
      }
    });
    await assert.rejects(() => service.add("instagram", "16:00"), /zurückgerollt/);
    assert.equal(calls, 2, "candidate apply fails, restored spec is reapplied once");
    assert.equal(readFileSync(runtime.path, "utf8"), original);
  } finally { rmSync(runtime.dir, { recursive: true, force: true }); }
});
