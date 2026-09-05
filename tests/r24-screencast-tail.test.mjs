import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CdpScreencastRecorder,
  SCREENCAST_DIAGNOSTIC_SECONDS
} from "../dist/adapters/browser/screencast-recorder.js";

function fakeClient() {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    send(method, params = {}) { calls.push({ method, params }); return Promise.resolve({}); },
    on(method, handler) { handlers.set(method, [...(handlers.get(method) ?? []), handler]); },
    off(method, handler) { handlers.set(method, (handlers.get(method) ?? []).filter((item) => item !== handler)); },
    emitFrame(sessionId, data) { for (const handler of handlers.get("Page.screencastFrame") ?? []) handler({ sessionId, data }); }
  };
}

const jpeg = Buffer.from("diagnostic-frame").toString("base64");

test("screencast keeps only the final thirty seconds while acknowledging the entire run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-tail-"));
  const oldFfmpeg = process.env.FFMPEG_EXECUTABLE_PATH;
  process.env.FFMPEG_EXECUTABLE_PATH = join(dir, "no-such-ffmpeg");
  try {
    const client = fakeClient();
    const recorder = new CdpScreencastRecorder(client, () => {});
    const fps = 2;
    const retained = fps * SCREENCAST_DIAGNOSTIC_SECONDS;
    const total = retained + 6;
    await recorder.start({ dir, name: "screencast-failure", fps });

    for (let index = 0; index < total; index += 1) client.emitFrame(index + 1, jpeg);

    const frameDirName = readdirSync(dir).find((entry) => entry.startsWith(".screencast-"));
    assert.ok(frameDirName);
    const frames = readdirSync(join(dir, frameDirName)).sort();
    assert.equal(SCREENCAST_DIAGNOSTIC_SECONDS, 30);
    assert.equal(frames.length, retained);
    assert.equal(frames[0], "frame-000006.jpg");
    assert.equal(frames.at(-1), `frame-${String(total - 1).padStart(6, "0")}.jpg`);
    assert.equal(client.calls.filter((call) => call.method === "Page.screencastFrameAck").length, total);

    assert.equal(await recorder.stop(), null, "missing ffmpeg only costs the optional clip");
    assert.deepEqual(readdirSync(dir), [], "temporary rolling frames are removed on stop");
  } finally {
    if (oldFfmpeg === undefined) delete process.env.FFMPEG_EXECUTABLE_PATH;
    else process.env.FFMPEG_EXECUTABLE_PATH = oldFfmpeg;
    rmSync(dir, { recursive: true, force: true });
  }
});
