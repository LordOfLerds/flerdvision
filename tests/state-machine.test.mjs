import test from "node:test";
import assert from "node:assert/strict";
import { canTransition, transition, InvalidTransitionError } from "../dist/domain/states.js";

test("uncertain publish cannot jump directly to VERIFIED", () => {
  assert.equal(canTransition("PUBLISH_UNCERTAIN", "VERIFIED"), false);
  assert.throws(() => transition("PUBLISH_UNCERTAIN", "VERIFIED"), InvalidTransitionError);
});

test("uncertain publish can reconcile through VERIFYING", () => {
  assert.equal(transition("PUBLISH_UNCERTAIN", "VERIFYING"), "VERIFYING");
  assert.equal(transition("VERIFYING", "VERIFIED"), "VERIFIED");
});

test("verified publication is terminal", () => {
  assert.equal(canTransition("VERIFIED", "READY"), false);
});
