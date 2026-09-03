import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEASE_STALE_AFTER_SECONDS } from "../dist/adapters/storage/sqlite.js";
import { DurableBrowserProfileLockAdapter } from "../dist/adapters/browser/profile-lock.js";

// Killed runs left four-hour leases on the Instagram and TikTok profiles and every later run
// was refused. A lease without a heartbeat for 15 minutes now belongs to a dead owner.

test("the stale bound is fifteen minutes and the store applies it before refusing", () => {
  assert.equal(LEASE_STALE_AFTER_SECONDS, 900);
  const sqlite = readFileSync(new URL("../src/adapters/storage/sqlite.ts", import.meta.url).pathname, "utf8");
  assert.match(sqlite, /existing\.ownerId !== ownerId && !stale\) return null;/);
  assert.match(sqlite, /addSeconds\(lastSign, LEASE_STALE_AFTER_SECONDS\) <= timestamp/);
});

test("a living holder heartbeats on its own and stops on release", async () => {
  const beats = [];
  const leases = {
    acquireLease: () => ({ resourceKey: "r", ownerId: "o", acquiredAt: "t", heartbeatAt: "t", expiresAt: "z" }),
    heartbeatLease: (key, owner) => { beats.push(owner); return { resourceKey: key, ownerId: owner, acquiredAt: "t", heartbeatAt: "t", expiresAt: "z" }; },
    releaseLease: () => true
  };
  const local = { acquire: () => ({ identityId: "i", ownerId: "o", heartbeat() {}, release() {} }) };
  const adapter = new DurableBrowserProfileLockAdapter(leases, local, 100, 15);
  const lock = adapter.acquire({ identityId: "i", profileKey: "p", accountId: "a", platform: "instagram", expectedHandle: "h" }, "o", new Date().toISOString());
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(beats.length >= 2, `expected automatic heartbeats, got ${beats.length}`);
  lock.release();
  const after = beats.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(beats.length, after);
});
