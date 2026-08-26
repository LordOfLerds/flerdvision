import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { FixtureIngressAdapter } from "../dist/adapters/ingress/fixture.js";
import {
  CurrentCreatorWeekDayPathInterpreter,
  MetadataFieldIngressInterpreter
} from "../dist/adapters/ingress/interpreters.js";
import { ContentIngressService, SourceAcknowledgementService } from "../dist/application/ingress-service.js";
import { RecordingSourceDispositionAdapter } from "../dist/adapters/disposition/adapters.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w2-"));
  return { dir, path: join(dir, "test.sqlite") };
}

function currentObservation(overrides = {}) {
  return {
    observationId: "obs:current:1",
    sourceId: "drive-current",
    externalObjectId: "drive-file-1",
    observedAt: "2026-08-26T06:30:00Z",
    locator: "gdrive://file/drive-file-1",
    mediaFingerprint: "drive-md5:aaaa",
    metadata: {
      relativePath: "06_ExampleCreator/KW_35/03_Mittwoch/Trial Reels/clip_01.mp4",
      weekStartDate: "2026-08-24",
      driveFileId: "drive-file-1",
      mimeType: "video/mp4"
    },
    ...overrides
  };
}

test("current creator/week/day schema materializes immutable content without coupling core to path names", async () => {
  const { dir, path } = tempDb();
  const store = new SqliteControlPlaneStore(path);
  try {
    const source = new FixtureIngressAdapter([currentObservation()]);
    const interpreter = new CurrentCreatorWeekDayPathInterpreter({
      creatorAliases: { "06_ExampleCreator": "creator_example" },
      formatFolderHints: { "trial reels": ["trial_reel"] }
    });
    const disposition = new RecordingSourceDispositionAdapter();
    const report = await new ContentIngressService(source, interpreter, store, disposition).run(
      "2026-08-26T06:31:00Z",
      { type: "test", id: "w2-current-schema" }
    );

    assert.deepEqual(report, {
      observed: 1,
      createdObservations: 1,
      duplicateObservations: 0,
      accepted: 1,
      ignored: 0,
      blocked: 0,
      conflicts: 0,
      createdContentItems: 1,
      existingContentItems: 0
    });
    const content = store.listContentItems()[0];
    assert.ok(content);
    assert.equal(content.item.creatorId, "creator_example");
    assert.equal(content.item.scheduledBusinessDate, "2026-08-26");
    assert.equal(content.item.metadata.formatHints, "trial_reel");
    assert.equal(content.item.immutableMediaRef, "gdrive://file/drive-file-1");
    assert.equal(store.getSourceObservation("obs:current:1")?.state, "ACCEPTED");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a completely different metadata-driven source plugs into the same ingress service", async () => {
  const { dir, path } = tempDb();
  const store = new SqliteControlPlaneStore(path);
  try {
    const observation = {
      observationId: "obs:future:1",
      sourceId: "future-source",
      externalObjectId: "asset-77",
      observedAt: "2026-08-26T07:00:00Z",
      locator: "future://asset/77",
      mediaFingerprint: "sha256:future77",
      metadata: {
        creator: "creator_example",
        publishDate: "2026-08-27",
        targets: "tiktok,short"
      }
    };
    const source = new FixtureIngressAdapter([observation]);
    const interpreter = new MetadataFieldIngressInterpreter({
      creatorField: "creator",
      businessDateField: "publishDate",
      formatHintsField: "targets",
      allowedCreatorIds: new Set(["creator_example"])
    });
    const report = await new ContentIngressService(
      source,
      interpreter,
      store,
      new RecordingSourceDispositionAdapter()
    ).run("2026-08-26T07:01:00Z", { type: "test", id: "w2-future-schema" });

    assert.equal(report.accepted, 1);
    const content = store.listContentItems()[0];
    assert.ok(content);
    assert.equal(content.item.creatorId, "creator_example");
    assert.equal(content.item.scheduledBusinessDate, "2026-08-27");
    assert.equal(content.item.metadata.formatHints, "tiktok,short");
    assert.equal(content.item.immutableMediaRef, "future://asset/77");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate observation increments seenCount but does not duplicate content", async () => {
  const { dir, path } = tempDb();
  const store = new SqliteControlPlaneStore(path);
  try {
    const source = new FixtureIngressAdapter([currentObservation()]);
    const interpreter = new CurrentCreatorWeekDayPathInterpreter({ creatorAliases: { "06_ExampleCreator": "creator_example" } });
    const service = new ContentIngressService(source, interpreter, store, new RecordingSourceDispositionAdapter());
    await service.run("2026-08-26T06:31:00Z", { type: "test", id: "first" });
    const second = await service.run("2026-08-26T06:32:00Z", { type: "test", id: "second" });

    assert.equal(second.duplicateObservations, 1);
    assert.equal(second.accepted, 0);
    assert.equal(store.listContentItems().length, 1);
    assert.equal(store.getSourceObservation("obs:current:1")?.seenCount, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same external source object changing media fingerprint fails closed", async () => {
  const { dir, path } = tempDb();
  const store = new SqliteControlPlaneStore(path);
  const disposition = new RecordingSourceDispositionAdapter();
  try {
    const interpreter = new CurrentCreatorWeekDayPathInterpreter({ creatorAliases: { "06_ExampleCreator": "creator_example" } });
    await new ContentIngressService(
      new FixtureIngressAdapter([currentObservation()]), interpreter, store, disposition, { notifyBlocksExternally: true }
    ).run("2026-08-26T06:31:00Z", { type: "test", id: "first" });

    const changed = currentObservation({ mediaFingerprint: "drive-md5:DIFFERENT" });
    const changedService = new ContentIngressService(
      new FixtureIngressAdapter([changed]), interpreter, store, disposition, { notifyBlocksExternally: true }
    );
    const report = await changedService.run("2026-08-26T06:32:00Z", { type: "test", id: "changed" });
    await changedService.run("2026-08-26T06:33:00Z", { type: "test", id: "changed-again" });

    assert.equal(report.conflicts, 1);
    assert.equal(report.blocked, 1);
    assert.equal(store.listContentItems().length, 1);
    assert.equal(store.getSourceObservation("obs:current:1")?.observation.mediaFingerprint, "drive-md5:aaaa");
    assert.equal(disposition.events.filter((event) => event.kind === "blocked").length, 1);
    assert.equal(store.getSourceDisposition("obs:current:1")?.state, "BLOCKED");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source acknowledgement is durable and idempotent across repeated completion calls", async () => {
  const { dir, path } = tempDb();
  const store = new SqliteControlPlaneStore(path);
  const disposition = new RecordingSourceDispositionAdapter();
  try {
    const source = new FixtureIngressAdapter([currentObservation()]);
    const interpreter = new CurrentCreatorWeekDayPathInterpreter({ creatorAliases: { "06_ExampleCreator": "creator_example" } });
    await new ContentIngressService(source, interpreter, store, disposition).run(
      "2026-08-26T06:31:00Z",
      { type: "test", id: "ingest" }
    );

    const ack = new SourceAcknowledgementService(store, disposition);
    await ack.complete("obs:current:1", ["pub:2", "pub:1"], "2026-08-26T18:00:00Z", { type: "test", id: "ack" });
    await ack.complete("obs:current:1", ["pub:1", "pub:2"], "2026-08-26T18:01:00Z", { type: "test", id: "ack-repeat" });

    const completionEvents = disposition.events.filter((event) => event.kind === "completed");
    assert.equal(completionEvents.length, 1);
    assert.deepEqual(store.getSourceDisposition("obs:current:1")?.publicationIds, ["pub:1", "pub:2"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("existing W1 database upgrades in place to migration 2", () => {
  const sourcePath = new URL("../runtime/admin-smoke.sqlite", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-w1-upgrade-"));
  const copied = join(dir, "upgrade.sqlite");
  copyFileSync(sourcePath, copied);
  const store = new SqliteControlPlaneStore(copied);
  try {
    assert.deepEqual(store.listSourceObservations(), []);
    assert.deepEqual(store.listContentItems(), []);
    assert.ok(store.summary("2026-08-26T18:00:00Z"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("blocked source acknowledgement is retried after sink failure without reinterpreting content", async () => {
  const { dir, path } = tempDb();
  const store = new SqliteControlPlaneStore(path);
  let calls = 0;
  const flakyDisposition = {
    async markCompleted() {},
    async markBlocked() {
      calls += 1;
      if (calls === 1) throw new Error("temporary sink outage");
    }
  };
  try {
    const observation = currentObservation({
      observationId: "obs:unknown:1",
      externalObjectId: "unknown-file",
      metadata: {
        relativePath: "Unknown_Creator/KW_35/03_Mittwoch/clip.mp4",
        weekStartDate: "2026-08-24"
      }
    });
    const source = new FixtureIngressAdapter([observation]);
    const interpreter = new CurrentCreatorWeekDayPathInterpreter({ creatorAliases: { "06_ExampleCreator": "creator_example" } });
    const service = new ContentIngressService(source, interpreter, store, flakyDisposition, { notifyBlocksExternally: true });

    await assert.rejects(
      service.run("2026-08-26T06:31:00Z", { type: "test", id: "sink-fails" }),
      /temporary sink outage/
    );
    assert.equal(store.getSourceObservation("obs:unknown:1")?.state, "BLOCKED");
    assert.equal(store.getSourceDisposition("obs:unknown:1"), null);

    const second = await service.run("2026-08-26T06:32:00Z", { type: "test", id: "sink-recovers" });
    assert.equal(second.duplicateObservations, 1);
    assert.equal(calls, 2);
    assert.equal(store.getSourceDisposition("obs:unknown:1")?.state, "BLOCKED");
    assert.equal(store.listContentItems().length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
