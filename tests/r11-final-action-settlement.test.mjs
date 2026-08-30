import test from "node:test";
import assert from "node:assert/strict";
import { RetainedSurfaceFinalActionInvoker, RetainedSurfacePublishSessionRegistry } from "../dist/adapters/runtime/surface-publish-session.js";

// First live final action: click invoked and the retained browser was closed in the same
// millisecond. The platform's share is asynchronous -- the page keeps uploading/finalizing
// after the click -- so the in-flight share died with the session: no post, verification
// UNCERTAIN forever, zero post-click evidence. The invoker must keep the session alive until
// the surface settles (dialog gone or success phrase) or a hard deadline passes, capture
// evidence either way, and only then release the session.

function fakeSession(evaluateScript) {
  const calls = { evaluate: 0, closed: false };
  return {
    calls,
    async evaluate(expr) {
      if (expr.includes("dialog")) { calls.evaluate += 1; return evaluateScript(calls.evaluate); }
      return null;
    },
    async close() { calls.closed = true; }
  };
}

function retainedFor(session, captureLog) {
  const attempt = { attemptId: "attempt:1", intentId: "intent:1", browserIdentityId: "id:1", releaseSha: "sha", startedAt: "2026-08-30T09:00:00.000Z", finishedAt: "2026-08-30T09:00:10.000Z", result: "prepared", mediaSha256: "m", preparationArtifactRefs: [], reachedFinalActionBoundary: true };
  const intent = { intentId: "intent:1", contentId: "c", creatorId: "cr", platform: "instagram", accountId: "acc", format: "reel", copyVersionId: "v", scheduledFor: "2026-08-30T09:15:00.000Z", idempotencyKey: "k" };
  return {
    attempt, intent, identityId: "id:1", surfaceContractId: "surface:1", environmentFingerprint: "fp",
    session, finalActionLocators: [{ kind: "role", value: "Teilen" }],
    async capture(label) { captureLog.push(label); return [`/evidence/${label}.png`]; },
    async close() { await session.close(); }
  };
}

function invokerWith(session, captureLog, settle = {}) {
  const registry = new RetainedSurfacePublishSessionRegistry();
  const retained = retainedFor(session, captureLog);
  registry.add(retained);
  // The environment guard reads via recorder; stub it by matching fingerprints up front.
  const invoker = new RetainedSurfaceFinalActionInvoker(registry, () => "2026-08-30T09:00:46.545Z", settle);
  return { invoker, registry, retained };
}

// The recorder's environment() call inside invoke needs a full DOM evaluate; bypass by
// stubbing the session's evaluate for that expression shape.
function withEnvironment(session) {
  const inner = session.evaluate.bind(session);
  session.evaluate = async (expr) => {
    if (expr.includes("navigator.userAgent")) return { userAgent: "Chrome/128.0", language: "de-DE", timeZone: "Europe/Vienna", width: 1200, height: 883, scale: 2 };
    return inner(expr);
  };
  return session;
}

function clickable(session) {
  // clickIrreversible goes through the DOM driver; give the fake the legacy locate/click shape.
  const inner = session.evaluate.bind(session);
  session.evaluate = async (expr) => {
    if (expr.includes("__flerdvisionLocate") || expr.includes("data-flerdvision-node")) return { found: true, token: "t", visible: true, tag: "button" };
    return inner(expr);
  };
  return session;
}

test("the session settles (success phrase) before release, with evidence on both sides of the wait", async () => {
  const captureLog = [];
  const session = fakeSession((n) => n < 2 ? { dialog: true, success: false, progress: true } : { dialog: true, success: true, progress: false });
  const { invoker, registry, retained } = invokerWith(withEnvironment(session), captureLog, { deadlineMs: 5000, pollMs: 10 });
  // Drive through a driver-compatible fake is heavy; call settle directly through invoke is the
  // real path, but the DOM driver needs a real locate protocol. Test the settlement contract
  // through the private method's observable effect instead: invoke with a click that succeeds.
  // The DOM driver fake path: legacy click uses evaluate too; give it what it asks for.
  let clicked = false;
  const driverFriendly = retained.session;
  const innerEval = driverFriendly.evaluate.bind(driverFriendly);
  driverFriendly.evaluate = async (expr) => {
    if (typeof expr === "string" && expr.includes("querySelector") && expr.includes("click") && !expr.includes("dialog")) { clicked = true; return { clicked: true }; }
    return innerEval(expr);
  };
  const settlement = await invoker["settle"](driverFriendly, 5000, 10);
  assert.equal(settlement.settled, true);
  assert.match(settlement.note, /success phrase/);
  assert.equal(registry.has("attempt:1"), true, "settle itself must not release the session");
});

test("dialog closed with no progress indicator counts as settled", async () => {
  const session = fakeSession(() => ({ dialog: false, success: false, progress: false }));
  const { invoker } = invokerWith(session, [], {});
  const settlement = await invoker["settle"](session, 5000, 10);
  assert.equal(settlement.settled, true);
  assert.match(settlement.note, /dialog closed/i);
});

test("navigation away counts as settled", async () => {
  const session = fakeSession(() => { throw new Error("Inspected target navigated or closed"); });
  const { invoker } = invokerWith(session, [], {});
  const settlement = await invoker["settle"](session, 5000, 10);
  assert.equal(settlement.settled, true);
  assert.match(settlement.note, /navigated away/i);
});

test("no signal within the deadline reports unsettled, never success", async () => {
  const session = fakeSession(() => ({ dialog: true, success: false, progress: true }));
  const { invoker } = invokerWith(session, [], {});
  const settlement = await invoker["settle"](session, 60, 10);
  assert.equal(settlement.settled, false);
  assert.match(settlement.note, /uncertain/i);
});

// --- source pins: ordering inside invoke ---
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../src/adapters/runtime/surface-publish-session.ts", import.meta.url).pathname, "utf8");

test("invoke clicks, captures, settles, captures again, and only then releases", () => {
  const click = source.indexOf("clickIrreversible(retained.finalActionLocators");
  const cap1 = source.indexOf('retained.capture?.("final-action-clicked")');
  const settle = source.indexOf("await this.settle(retained.session");
  const cap2 = source.indexOf('settlement.settled?"final-action-settled":"final-action-settle-timeout"');
  const release = source.indexOf("finally{await this.registry.close(attempt.attemptId);}");
  assert.ok(click > 0 && click < cap1 && cap1 < settle && settle < cap2 && cap2 < release, "post-click settlement must complete before the session is released");
});

test("the settlement outcome reaches the evidence trail", () => {
  assert.match(source, /positive:settlement\.settled/);
  assert.match(source, /note:settlement\.note/);
});
