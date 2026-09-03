import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SafePlatformExecutionRunner } from "../dist/adapters/browser/platform-execution-runner.js";
import { AutonomousSurfaceExplorer } from "../dist/adapters/browser/autonomous-surface-explorer.js";

// A recording is evidence, never a participant. These tests pin the only two promises the run
// legs make about it: the MP4 joins the artifacts of the leg that produced it, and absolutely
// nothing the recorder does -- refusing to start, throwing on stop, not existing at all -- can
// change what the leg itself does or reports.

const ENVIRONMENT = { userAgent: "Mozilla/5.0 (Macintosh) Chrome/128.0.0.0 Safari/537.36", language: "de-DE", timeZone: "Europe/Vienna", width: 1200, height: 883, scale: 2 };
const FINGERPRINT = createHash("sha256").update(JSON.stringify([128, ENVIRONMENT.language, ENVIRONMENT.timeZone, ENVIRONMENT.width, ENVIRONMENT.height, ENVIRONMENT.scale])).digest("hex");

const INTENT = {
  intentId: "intent-screencast", accountId: "acc", platform: "instagram", format: "reel",
  contentId: "content", creatorId: "creator", copyVersionId: "copy", scheduledFor: "2026-09-03T10:00:00.000Z", idempotencyKey: "key"
};
const IDENTITY = { identityId: "identity", accountId: "acc", platform: "instagram", profileKey: "profile", expectedHandle: "handle", enabled: true };
const PLAN = {
  intent: INTENT,
  provenance: { planId: "p", deliveryId: "d", routeId: "r", laneId: "l", assetId: "a", postingProfileId: "pp", copyProfileId: "cp", schedulePolicyId: "sp", routeSnapshotFingerprint: "f" },
  postingProfile: { postingProfileId: "pp", displayName: "IG", platform: "instagram", format: "reel", visibility: "public", enabled: true },
  surfaceContractId: "surface:test",
  environmentFingerprint: FINGERPRINT,
  actions: [{ stepKey: "FINAL_ACTION", operation: "FINAL_BOUNDARY", locators: [{ kind: "role", value: "Teilen" }] }]
};

function session(screencast) {
  return {
    identityId: IDENTITY.identityId,
    profileDirectory: "/profiles/profile",
    ...(screencast ? { screencast } : {}),
    async navigate() {},
    async currentUrl() { return "https://www.instagram.com/"; },
    async evaluate(expression) {
      if (expression.includes("navigator.userAgent")) return ENVIRONMENT;
      return { token: "target-1", descriptor: 'button "Teilen"' };
    },
    async setInputFiles() {},
    async captureScreenshot() {},
    async setCookie() {},
    async cookies() { return []; },
    async close() {}
  };
}

function artifacts(directory, log) {
  return {
    async captureBoundary(_session, _intent, _identity, label) { log.push(`capture:${label}`); return [`/evidence/${label}.png`]; },
    async writeJournal() { log.push("journal"); return "/evidence/journal.json"; },
    ...(directory === undefined ? {} : { recordingDirectory: () => directory })
  };
}

/** A recorder that records nothing but remembers exactly how it was driven. */
function recorder(options = {}) {
  const log = options.log ?? [];
  return {
    log,
    async start(startOptions) { log.push("start"); this.startedWith = startOptions; if (options.throwOnStart) throw new Error("recorder refused to start"); },
    async stop() { log.push("stop"); if (options.throwOnStop) throw new Error("recorder exploded on stop"); return options.path ?? null; }
  };
}

function withScreencast(value, run) {
  const previous = process.env.FLERDVISION_SCREENCAST;
  process.env.FLERDVISION_SCREENCAST = value;
  return (async () => {
    try { return await run(); }
    finally { if (previous === undefined) delete process.env.FLERDVISION_SCREENCAST; else process.env.FLERDVISION_SCREENCAST = previous; }
  })();
}

test("a replay leg wraps its own work in the recording and returns the MP4 with its artifacts", async () => {
  await withScreencast("1", async () => {
    const log = [];
    const tape = recorder({ log, path: "/evidence/intent-screencast/screencast-surface-replay-instagram.mp4" });
    const result = await new SafePlatformExecutionRunner(session(tape), artifacts("/evidence/intent-screencast", log), () => "2026-09-03T10:00:00.000Z").execute(PLAN, IDENTITY, { mediaPath: "/media/clip.mp4" });

    assert.equal(result.reachedFinalActionBoundary, true);
    assert.equal(result.finalActionInvoked, false);
    assert.equal(result.artifactRefs.at(-1), "/evidence/intent-screencast/screencast-surface-replay-instagram.mp4");
    assert.equal(log[0], "start", "the recording must start before the leg does anything");
    assert.equal(log.at(-1), "stop", "and end only once the leg is finished");
    assert.deepEqual(tape.startedWith, { dir: "/evidence/intent-screencast", name: "screencast-surface-replay-instagram", maxWidth: 960, quality: 60, fps: 2 });
  });
});

test("a replay leg is untouched when the recorder throws at both ends", async () => {
  await withScreencast("1", async () => {
    const log = [];
    const tape = recorder({ log, throwOnStart: true, throwOnStop: true });
    const result = await new SafePlatformExecutionRunner(session(tape), artifacts("/evidence/intent-screencast", log), () => "2026-09-03T10:00:00.000Z").execute(PLAN, IDENTITY, { mediaPath: "/media/clip.mp4" });
    assert.equal(result.reachedFinalActionBoundary, true);
    assert.equal(result.artifactRefs.some((ref) => ref.endsWith(".mp4")), false);
  });
});

test("a failing replay still reports its own failure, not the recorder's", async () => {
  await withScreencast("1", async () => {
    const log = [];
    const tape = recorder({ log, throwOnStop: true });
    const wrongIdentity = { ...IDENTITY, accountId: "someone-else" };
    await assert.rejects(
      () => new SafePlatformExecutionRunner(session(tape), artifacts("/evidence/intent-screencast", log), () => "2026-09-03T10:00:00.000Z").execute(PLAN, wrongIdentity, { mediaPath: "/media/clip.mp4" }),
      /Execution identity does not match plan account\/platform/
    );
    assert.deepEqual(log, ["start", "stop"], "the recording is stopped on the failure path too");
  });
});

test("recording stays off unless it is switched on, wired, and given a directory", async () => {
  const off = recorder({ path: "/evidence/x.mp4" });
  await withScreencast("0", async () => {
    await new SafePlatformExecutionRunner(session(off), artifacts("/evidence/intent-screencast", []), () => "2026-09-03T10:00:00.000Z").execute(PLAN, IDENTITY, { mediaPath: "/media/clip.mp4" });
  });
  assert.deepEqual(off.log, [], "FLERDVISION_SCREENCAST=0 records nothing");

  await withScreencast("1", async () => {
    const noDirectory = recorder({ path: "/evidence/x.mp4" });
    const result = await new SafePlatformExecutionRunner(session(noDirectory), artifacts(undefined, []), () => "2026-09-03T10:00:00.000Z").execute(PLAN, IDENTITY, { mediaPath: "/media/clip.mp4" });
    assert.deepEqual(noDirectory.log, [], "a sink with nowhere to put a recording records nothing");
    assert.equal(result.artifactRefs.some((ref) => ref.endsWith(".mp4")), false);

    // A session fake without the capability at all is the common case in this suite.
    const plain = await new SafePlatformExecutionRunner(session(undefined), artifacts("/evidence/intent-screencast", []), () => "2026-09-03T10:00:00.000Z").execute(PLAN, IDENTITY, { mediaPath: "/media/clip.mp4" });
    assert.equal(plain.reachedFinalActionBoundary, true);
  });
});

test("surface discovery records around its whole run and never masks its own failure", async () => {
  await withScreencast("1", async () => {
    const log = [];
    const tape = recorder({ log, throwOnStop: true });
    const explorer = new AutonomousSurfaceExplorer(session(tape), artifacts("/evidence/intent-screencast", log));
    await assert.rejects(
      () => explorer.discoverAndPrepare({
        intent: INTENT,
        identity: { ...IDENTITY, accountId: "someone-else" },
        postingProfile: PLAN.postingProfile,
        mediaPath: "/media/clip.mp4"
      }),
      /Surface exploration identity does not match intent/
    );
    assert.deepEqual(log, ["start", "stop"]);
    assert.deepEqual(tape.startedWith, { dir: "/evidence/intent-screencast", name: "screencast-surface-discovery-instagram", maxWidth: 960, quality: 60, fps: 2 });
  });
});

test("the CLI records an attended demo by default and the unattended daemon too (the operator wants the video of every real post)", () => {
  const cli = readFileSync(new URL("../src/cli/flerdvision.ts", import.meta.url).pathname, "utf8");
  const demo = cli.slice(cli.indexOf('command === "demo"'), cli.indexOf('command === "notify-test"'));
  const runtime = cli.slice(cli.indexOf('command === "run-once" || command === "daemon"'));
  assert.match(demo, /applyScreencastDefault\(process\.env, true\)/);
  assert.match(runtime, /applyScreencastDefault\(process\.env, true\)/);
  assert.match(cli, /FLERDVISION_SCREENCAST/, "the switch is documented in the command help");
});
