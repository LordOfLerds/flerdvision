import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserProfileDirectoryResolver, FileBrowserProfileLockAdapter, BrowserProfileLockedError } from "../dist/adapters/browser/profile-lock.js";

// A crashed or killed run never reaches release(), and heartbeat is a no-op. Without staleness
// detection the profile stays locked forever and the only recovery is deleting state by hand --
// which the acceptance contract forbids.

const IDENTITY = { identityId: "browser:instagram:test", accountId: "account:test", platform: "instagram", profileKey: "instagram/test", expectedHandle: "test", enabled: true };
const NOW = "2026-08-28T12:00:00.000Z";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-lock-"));
  const resolver = new BrowserProfileDirectoryResolver(root);
  const lockPath = `${resolver.resolve(IDENTITY.profileKey)}.flerdvision.lock`;
  return { root, adapter: new FileBrowserProfileLockAdapter(resolver), lockPath, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }) };
}

test("a lock records the owning process so staleness can be judged later", () => {
  const h = harness();
  try {
    const lock = h.adapter.acquire(IDENTITY, "owner-a", NOW);
    const written = JSON.parse(readFileSync(h.lockPath, "utf8"));
    assert.equal(written.pid, process.pid);
    assert.equal(written.ownerId, "owner-a");
    lock.release();
    assert.equal(existsSync(h.lockPath), false);
  } finally { h.cleanup(); }
});

test("a lock held by a live process is still refused", () => {
  const h = harness();
  try {
    const first = h.adapter.acquire(IDENTITY, "owner-a", NOW);
    // This process is alive, so the profile must stay protected: concurrent use is forbidden.
    assert.throws(() => h.adapter.acquire(IDENTITY, "owner-b", NOW), BrowserProfileLockedError);
    first.release();
  } finally { h.cleanup(); }
});

test("the refusal names who holds the profile so the operator can act", () => {
  const h = harness();
  try {
    const first = h.adapter.acquire(IDENTITY, "headless-login:instagram", NOW);
    try {
      h.adapter.acquire(IDENTITY, "owner-b", NOW);
      assert.fail("expected a refusal");
    } catch (error) {
      assert.match(error.message, /headless-login:instagram/);
      assert.match(error.message, new RegExp(`pid ${process.pid}`));
    }
    first.release();
  } finally { h.cleanup(); }
});

test("a lock whose owner is gone is reclaimed instead of blocking forever", () => {
  const h = harness();
  try {
    // pid 0x7FFFFFFF will not exist; this is the crashed-run case that used to be unrecoverable.
    writeFileSync(h.lockPath, JSON.stringify({ identityId: IDENTITY.identityId, ownerId: "dead-run", acquiredAt: NOW, pid: 0x7fffffff }));
    const lock = h.adapter.acquire(IDENTITY, "owner-new", NOW);
    assert.equal(JSON.parse(readFileSync(h.lockPath, "utf8")).ownerId, "owner-new");
    lock.release();
  } finally { h.cleanup(); }
});

test("a pre-existing lock without a pid is reclaimable", () => {
  const h = harness();
  try {
    // Exactly the shape this repository wrote before staleness detection existed.
    writeFileSync(h.lockPath, JSON.stringify({ identityId: IDENTITY.identityId, ownerId: "headless-login:instagram-flerdvision", acquiredAt: NOW }));
    const lock = h.adapter.acquire(IDENTITY, "owner-new", NOW);
    assert.equal(JSON.parse(readFileSync(h.lockPath, "utf8")).pid, process.pid);
    lock.release();
  } finally { h.cleanup(); }
});

test("an unparseable lock file does not permanently block the profile", () => {
  const h = harness();
  try {
    writeFileSync(h.lockPath, "{ torn write");
    const lock = h.adapter.acquire(IDENTITY, "owner-new", NOW);
    lock.release();
  } finally { h.cleanup(); }
});

test("age alone never reclaims a lock whose owner is alive", () => {
  const h = harness();
  try {
    // A real operator login can sit at a browser for the better part of an hour. An age-based
    // rule would steal the profile mid-login; only a dead owner may be overridden.
    writeFileSync(h.lockPath, JSON.stringify({ identityId: IDENTITY.identityId, ownerId: "long-login", acquiredAt: "2020-01-01T00:00:00.000Z", pid: process.pid }));
    assert.throws(() => h.adapter.acquire(IDENTITY, "owner-b", NOW), BrowserProfileLockedError);
  } finally { h.cleanup(); }
});
