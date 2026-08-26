import test from "node:test";
import assert from "node:assert/strict";
import { PublishOrchestrator } from "../dist/application/publish-orchestrator.js";
import { FakePublisher, FakeVerifier } from "../dist/adapters/inmemory/fakes.js";

const intent = {
  intentId: "intent-1",
  contentId: "content-1",
  creatorId: "creator-test",
  platform: "instagram",
  accountId: "test-instagram",
  format: "reel",
  copyVersionId: "copy-1",
  scheduledFor: "2026-08-26T09:00:00+02:00",
  idempotencyKey: "stable-key-1"
};

test("prepare_only never invokes final publish", async () => {
  const publisher = new FakePublisher();
  const orchestrator = new PublishOrchestrator(publisher, new FakeVerifier("verified"));
  const result = await orchestrator.execute(intent, {
    mode: "prepare_only",
    allowFinalPublish: false,
    allowedAccountIds: new Set(["test-instagram"]),
    releaseSha: "test"
  });
  assert.equal(result.kind, "prepared_only");
  assert.equal(publisher.finalInvocations, 0);
});

test("test mode requires allowlist and evidence before verified outcome", async () => {
  const publisher = new FakePublisher();
  const orchestrator = new PublishOrchestrator(publisher, new FakeVerifier("verified"));
  const result = await orchestrator.execute(intent, {
    mode: "test_account",
    allowFinalPublish: true,
    allowedAccountIds: new Set(["test-instagram"]),
    releaseSha: "test"
  });
  assert.equal(result.kind, "verified");
  assert.equal(publisher.finalInvocations, 1);
});

test("missing verification evidence yields uncertain, not success", async () => {
  const publisher = new FakePublisher();
  const orchestrator = new PublishOrchestrator(publisher, new FakeVerifier("uncertain"));
  const result = await orchestrator.execute(intent, {
    mode: "test_account",
    allowFinalPublish: true,
    allowedAccountIds: new Set(["test-instagram"]),
    releaseSha: "test"
  });
  assert.equal(result.kind, "uncertain");
});
