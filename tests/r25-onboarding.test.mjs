import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessOnboardingService } from "../dist/application/headless-onboarding.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-onboarding-"));
  const source = join(dir, "source");
  const reels = join(source, "Kunde A Instagram Reels");
  mkdirSync(reels, { recursive: true });
  writeFileSync(join(reels, "01 Hallo.mp4"), "fixture");
  const specPath = join(dir, "flerdvision.json");
  const spec = {
    schemaVersion: 1,
    workspace: { id: "onboarding-test", name: "Onboarding Test", timezone: "Europe/Vienna", runtimeRoot: join(dir, "runtime") },
    source: { kind: "local_folder", root: source, structure: "auto", activation: "IMPORT_BACKLOG", maxDepth: 4 },
    customers: [{ key: "kunde-a", name: "Kunde A" }],
    channels: [{ key: "instagram-a", name: "Instagram", customerKey: "kunde-a", platform: "instagram", handle: "kunde_a", formats: [{ type: "reel", times: ["12:00"], sourceMatch: ["reels"] }] }]
  };
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const env = { TZ: "Europe/Vienna", FLERDVISION_TELEGRAM_BOT_TOKEN: "secret-bot-token", FLERDVISION_TELEGRAM_CHAT_ID: "secret-chat-id" };
  const service = new HeadlessOnboardingService({ specPath, releaseSha: "test-release", env });
  return { dir, source, specPath, env, service, close() { rmSync(dir, { recursive: true, force: true }); } };
}

test("onboarding advances only through explicit root topology and activation confirmations", async () => {
  const f = fixture();
  try {
    const start = await f.service.status("2026-09-05T10:00:00.000Z");
    assert.equal(start.driveConnected, true);
    assert.equal(start.rootConfirmed, false);
    assert.equal(start.stage, "DRIVE_CONNECTED");
    assert.equal(start.streams[0].customerName, "Kunde A");
    assert.match(start.streams[0].folderPath, /Kunde A Instagram Reels/);

    const root = await f.service.confirmRoot("2026-09-05T10:01:00.000Z");
    assert.equal(root.rootConfirmed, true);
    assert.equal(root.topologyConfirmed, false);
    assert.equal(root.stage, "ROOT_CONFIRMED");

    const topology = await f.service.confirmTopology("2026-09-05T10:02:00.000Z");
    assert.equal(topology.topologyConfirmed, true);
    assert.equal(topology.activationConfirmed, false);
    assert.equal(topology.stage, "TOPOLOGY_CONFIRMED");

    const activated = await f.service.activate("2026-09-05T10:03:00.000Z");
    assert.equal(activated.activationConfirmed, true);
    assert.equal(activated.accountsLoggedIn, false);
    assert.equal(activated.stage, "ACTIVATION_CONFIRMED");
  } finally { f.close(); }
});

test("telegram onboarding proof stores only a one-way fingerprint, never credentials", async () => {
  const f = fixture();
  try {
    await f.service.confirmRoot("2026-09-05T10:01:00.000Z");
    await f.service.confirmTopology("2026-09-05T10:02:00.000Z");
    await f.service.activate("2026-09-05T10:03:00.000Z");
    const status = await f.service.markTelegramTested("2026-09-05T10:04:00.000Z");
    assert.equal(status.telegramTested, true);
    const persistedPath = join(f.dir, "runtime", "workspaces", "onboarding-test", "config", "onboarding.json");
    const persisted = readFileSync(persistedPath, "utf8");
    assert.doesNotMatch(persisted, /secret-bot-token|secret-chat-id/);
    assert.match(persisted, /telegramFingerprint/);
  } finally { f.close(); }
});

test("changing the canonical source root invalidates root and all downstream confirmations", async () => {
  const f = fixture();
  try {
    await f.service.confirmRoot("2026-09-05T10:01:00.000Z");
    await f.service.confirmTopology("2026-09-05T10:02:00.000Z");
    await f.service.activate("2026-09-05T10:03:00.000Z");

    const other = join(f.dir, "source-2");
    mkdirSync(join(other, "Kunde A Instagram Reels"), { recursive: true });
    writeFileSync(join(other, "Kunde A Instagram Reels", "02 Neu.mp4"), "fixture");
    const raw = JSON.parse(readFileSync(f.specPath, "utf8"));
    raw.source.root = other;
    writeFileSync(f.specPath, `${JSON.stringify(raw, null, 2)}\n`);

    const changed = await f.service.status("2026-09-05T11:00:00.000Z");
    assert.equal(changed.rootConfirmed, false);
    assert.equal(changed.topologyConfirmed, false);
    assert.equal(changed.activationConfirmed, false);
    assert.equal(changed.stage, "DRIVE_CONNECTED");
  } finally { f.close(); }
});
