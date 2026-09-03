import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CdpScreencastRecorder,
  applyScreencastDefault,
  beginScreencast,
  everyNthFrameFor,
  pruneRecordings,
  screencastEnabled
} from "../dist/adapters/browser/screencast-recorder.js";
import { resolveFfmpegExecutablePath } from "../dist/adapters/media/resolve-ffmpeg.js";

// The recording is evidence for a human and nothing else. Every assertion here exists to prove
// one thing: a screencast that cannot work must cost the recording and never the run.

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-screencast-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeClient() {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    send(method, params = {}) { calls.push({ method, params }); return Promise.resolve({}); },
    on(method, handler) { handlers.set(method, [...(handlers.get(method) ?? []), handler]); },
    off(method, handler) { handlers.set(method, (handlers.get(method) ?? []).filter((item) => item !== handler)); },
    emitFrame(sessionId, data) { for (const handler of handlers.get("Page.screencastFrame") ?? []) handler({ sessionId, data }); },
    subscribers() { return (handlers.get("Page.screencastFrame") ?? []).length; }
  };
}

const jpeg = Buffer.from("fake-frame-bytes").toString("base64");

let ffmpegAvailable = true;
try { resolveFfmpegExecutablePath(); } catch { ffmpegAvailable = false; }
if (!ffmpegAvailable) console.error("SKIPPING the ffmpeg assembly test: no ffmpeg on this host (set FFMPEG_EXECUTABLE_PATH to run it).");

test("every delivered frame is written and acknowledged with its own session id", async () => {
  const { dir, cleanup } = workspace();
  try {
    const client = fakeClient();
    const recorder = new CdpScreencastRecorder(client, () => {});
    await recorder.start({ dir, name: "run", fps: 2, quality: 60, maxWidth: 960 });

    const started = client.calls.find((call) => call.method === "Page.startScreencast");
    assert.equal(started.params.format, "jpeg");
    assert.equal(started.params.maxWidth, 960);
    assert.equal(started.params.quality, 60);
    assert.equal(started.params.everyNthFrame, everyNthFrameFor(2));

    client.emitFrame(11, jpeg);
    client.emitFrame(12, jpeg);
    const acks = client.calls.filter((call) => call.method === "Page.screencastFrameAck");
    assert.deepEqual(acks.map((call) => call.params.sessionId), [11, 12]);

    const frameDir = readdirSync(dir).find((entry) => entry.startsWith(".screencast-"));
    assert.deepEqual(readdirSync(join(dir, frameDir)), ["frame-000000.jpg", "frame-000001.jpg"]);
    await recorder.stop();
  } finally { cleanup(); }
});

test("a frame is acknowledged even when its bytes cannot be written", async () => {
  // Chromium sends exactly one more frame if an ack is missed; losing the stream over a full
  // disk would be a silent, permanent stop rather than a gap in the evidence.
  const { dir, cleanup } = workspace();
  try {
    const client = fakeClient();
    const recorder = new CdpScreencastRecorder(client, () => {});
    await recorder.start({ dir, name: "run" });
    const frameDir = join(dir, readdirSync(dir).find((entry) => entry.startsWith(".screencast-")));
    rmSync(frameDir, { recursive: true, force: true });
    client.emitFrame(5, jpeg);
    assert.deepEqual(client.calls.filter((call) => call.method === "Page.screencastFrameAck").map((call) => call.params.sessionId), [5]);
    assert.equal(await recorder.stop(), null);
  } finally { cleanup(); }
});

test("stop without ffmpeg returns null, never throws, and leaves no frames behind", async () => {
  const { dir, cleanup } = workspace();
  const previous = process.env.FFMPEG_EXECUTABLE_PATH;
  process.env.FFMPEG_EXECUTABLE_PATH = join(dir, "no-such-ffmpeg");
  const logged = [];
  try {
    const client = fakeClient();
    const recorder = new CdpScreencastRecorder(client, (message) => logged.push(message));
    await recorder.start({ dir, name: "run" });
    client.emitFrame(1, jpeg);
    assert.equal(await recorder.stop(), null);
    assert.equal(logged.length, 1, `expected exactly one log line, got ${JSON.stringify(logged)}`);
    assert.match(logged[0], /ffmpeg/i);
    assert.equal(client.calls.some((call) => call.method === "Page.stopScreencast"), true);
    assert.equal(client.subscribers(), 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_EXECUTABLE_PATH; else process.env.FFMPEG_EXECUTABLE_PATH = previous;
    cleanup();
  }
});

test("a screencast that never started, or that captured nothing, stops as null", async () => {
  const { dir, cleanup } = workspace();
  try {
    const recorder = new CdpScreencastRecorder(fakeClient(), () => {});
    assert.equal(await recorder.stop(), null);
    await recorder.start({ dir, name: "run" });
    assert.equal(await recorder.stop(), null);
    assert.equal(await recorder.stop(), null);
    assert.deepEqual(readdirSync(dir), []);
  } finally { cleanup(); }
});

test("a refused Page.startScreencast is logged and leaves nothing recording", async () => {
  const { dir, cleanup } = workspace();
  const logged = [];
  try {
    const client = fakeClient();
    client.send = (method) => method === "Page.startScreencast" ? Promise.reject(new Error("protocol refused")) : Promise.resolve({});
    const recorder = new CdpScreencastRecorder(client, (message) => logged.push(message));
    await recorder.start({ dir, name: "run" });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /protocol refused/);
    assert.equal(client.subscribers(), 0);
    assert.equal(await recorder.stop(), null);
    assert.deepEqual(readdirSync(dir), []);
  } finally { cleanup(); }
});

test("a nested start does not restart or truncate the recording the outer leg owns", async () => {
  // The publish leg records while the execution runner inside it asks for its own recording.
  const { dir, cleanup } = workspace();
  try {
    const client = fakeClient();
    const recorder = new CdpScreencastRecorder(client, () => {});
    await recorder.start({ dir, name: "outer" });
    await recorder.start({ dir, name: "inner" });
    assert.equal(client.calls.filter((call) => call.method === "Page.startScreencast").length, 1);
    assert.equal(await recorder.stop(), null, "the inner stop must not end the outer recording");
    assert.equal(client.calls.some((call) => call.method === "Page.stopScreencast"), false);
    client.emitFrame(1, jpeg);
    const frameDir = readdirSync(dir).find((entry) => entry.startsWith(".screencast-"));
    assert.equal(readdirSync(join(dir, frameDir)).length, 1, "the outer recording still receives frames");
    await recorder.stop();
    assert.equal(client.calls.some((call) => call.method === "Page.stopScreencast"), true);
  } finally { cleanup(); }
});

test("FLERDVISION_SCREENCAST decides whether a session records at all", async () => {
  assert.equal(screencastEnabled({}), false);
  assert.equal(screencastEnabled({ FLERDVISION_SCREENCAST: "1" }), true);
  assert.equal(screencastEnabled({ FLERDVISION_SCREENCAST: "TRUE" }), true);
  assert.equal(screencastEnabled({ FLERDVISION_SCREENCAST: " on " }), true);
  assert.equal(screencastEnabled({ FLERDVISION_SCREENCAST: "0" }), false);
  assert.equal(screencastEnabled({ FLERDVISION_SCREENCAST: "false" }), false);

  const unset = {};
  applyScreencastDefault(unset, true);
  assert.equal(unset.FLERDVISION_SCREENCAST, "1");
  const off = {};
  applyScreencastDefault(off, false);
  assert.equal(off.FLERDVISION_SCREENCAST, "0");
  const operator = { FLERDVISION_SCREENCAST: "0" };
  applyScreencastDefault(operator, true);
  assert.equal(operator.FLERDVISION_SCREENCAST, "0", "an explicit operator choice always wins");
});

test("beginScreencast records only when it is switched on, wired, and given a directory", async () => {
  const { dir, cleanup } = workspace();
  try {
    const started = [];
    const session = { screencast: { start: async (options) => { started.push(options); }, stop: async () => "/evidence/run.mp4" } };
    assert.equal(await beginScreencast(session, dir, "run", {}), null, "off by default");
    assert.equal(await beginScreencast({}, dir, "run", { FLERDVISION_SCREENCAST: "1" }), null, "a session without a recorder");
    assert.equal(await beginScreencast(session, undefined, "run", { FLERDVISION_SCREENCAST: "1" }), null, "no evidence directory");
    assert.deepEqual(started, []);

    const recording = await beginScreencast(session, dir, "run", { FLERDVISION_SCREENCAST: "1" });
    assert.deepEqual(started, [{ dir, name: "run", maxWidth: 960, quality: 60, fps: 2 }]);
    assert.equal(await recording.stop(), "/evidence/run.mp4");
  } finally { cleanup(); }
});

test("beginScreencast swallows a recorder that throws on start and on stop", async () => {
  const { dir, cleanup } = workspace();
  const logged = [];
  try {
    const throwsOnStart = { screencast: { start: async () => { throw new Error("no screencast here"); }, stop: async () => null } };
    assert.equal(await beginScreencast(throwsOnStart, dir, "run", { FLERDVISION_SCREENCAST: "1" }, (m) => logged.push(m)), null);

    const throwsOnStop = { screencast: { start: async () => {}, stop: async () => { throw new Error("assembly exploded"); } } };
    const recording = await beginScreencast(throwsOnStop, dir, "run", { FLERDVISION_SCREENCAST: "1" }, (m) => logged.push(m));
    assert.equal(await recording.stop(), null);
    assert.equal(logged.length, 2);
  } finally { cleanup(); }
});

test("pruneRecordings deletes stale recordings and abandoned frame directories only", async () => {
  const { dir, cleanup } = workspace();
  try {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fresh = new Date();
    const stale = join(dir, "stale.mp4");
    const recent = join(dir, "recent.mp4");
    const evidence = join(dir, "boundary.png");
    const abandoned = join(dir, ".screencast-run-abcdef");
    writeFileSync(stale, "x");
    writeFileSync(recent, "x");
    writeFileSync(evidence, "x");
    mkdirSync(abandoned);
    writeFileSync(join(abandoned, "frame-000000.jpg"), "x");
    utimesSync(stale, old, old);
    utimesSync(evidence, old, old);
    utimesSync(abandoned, old, old);
    utimesSync(recent, fresh, fresh);

    const removed = pruneRecordings(dir, 14);
    assert.deepEqual([...removed].sort(), [abandoned, stale].sort());
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(abandoned), false);
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(evidence), true, "screenshots are never pruned by the recorder");
    assert.deepEqual(pruneRecordings(join(dir, "does-not-exist")), []);
  } finally { cleanup(); }
});

test("frames are assembled into one MP4 next to the screenshots", { skip: !ffmpegAvailable }, async () => {
  const { dir, cleanup } = workspace();
  try {
    // A real 2x2 JPEG, so ffmpeg has something it can genuinely decode.
    const pixels = Buffer.from(
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiiiiiiiiiiiiiiiiiiiiiv/2Q==",
      "base64"
    ).toString("base64");
    const client = fakeClient();
    const recorder = new CdpScreencastRecorder(client, () => {});
    await recorder.start({ dir, name: "surface-run", fps: 2 });
    for (let index = 0; index < 4; index += 1) client.emitFrame(index, pixels);
    const path = await recorder.stop();
    assert.equal(path, join(dir, "surface-run.mp4"));
    assert.ok(statSync(path).size > 0, "the recording must not be empty");
    assert.deepEqual(readdirSync(dir), ["surface-run.mp4"], "frames are deleted once assembled");
  } finally { cleanup(); }
});
