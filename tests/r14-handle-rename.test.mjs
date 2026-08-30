import test from "node:test";
import assert from "node:assert/strict";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";

// Multi-account finding B12, hit live: the operator renamed a channel (new YouTube handle on
// the same spec key) and every bootstrap failed with "already exists with different
// configuration". A rename is a legitimate operator change; identity anchors (platform,
// account binding, profile key) stay immutable, and re-verification is implicit because the
// guard compares the new expected handle against a live probe.

const actor = { type: "system", id: "test" };

function store() {
  const s = new SqliteControlPlaneStore(":memory:");
  s.registerSocialAccount({ accountId: "acc", platform: "youtube", expectedHandle: "oldhandle", enabled: true }, "2026-08-31T06:00:00Z", actor);
  s.registerBrowserIdentity({ identityId: "id", accountId: "acc", platform: "youtube", profileKey: "youtube/acc", expectedHandle: "oldhandle", enabled: true }, "2026-08-31T06:00:01Z", actor);
  return s;
}

test("renaming the handle on the same key updates account and identity", () => {
  const s = store();
  const account = s.registerSocialAccount({ accountId: "acc", platform: "youtube", expectedHandle: "newhandle", enabled: true }, "2026-08-31T07:00:00Z", actor);
  assert.equal(account.created, false);
  assert.equal(account.record.account.expectedHandle, "newhandle");
  const identity = s.registerBrowserIdentity({ identityId: "id", accountId: "acc", platform: "youtube", profileKey: "youtube/acc", expectedHandle: "newhandle", enabled: true }, "2026-08-31T07:00:01Z", actor);
  assert.equal(identity.record.identity.expectedHandle, "newhandle");
  s.close();
});

test("a platform change on an existing key is still refused", () => {
  const s = store();
  assert.throws(() => s.registerSocialAccount({ accountId: "acc", platform: "tiktok", expectedHandle: "oldhandle", enabled: true }, "2026-08-31T07:00:00Z", actor), /cannot change platform/);
  s.close();
});

test("an identity may never migrate to another profile or account", () => {
  const s = store();
  assert.throws(() => s.registerBrowserIdentity({ identityId: "id", accountId: "acc", platform: "youtube", profileKey: "youtube/other", expectedHandle: "oldhandle", enabled: true }, "2026-08-31T07:00:00Z", actor), /different configuration/);
  s.close();
});

test("the rename is journaled with both handles", () => {
  const s = store();
  s.registerSocialAccount({ accountId: "acc", platform: "youtube", expectedHandle: "newhandle", enabled: true }, "2026-08-31T07:00:00Z", actor);
  const events = s.listEvents("social_account", "acc").filter((e) => e.eventType === "social_account.reconfigured");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.fromHandle, "oldhandle");
  assert.equal(events[0].payload.toHandle, "newhandle");
  s.close();
});
