import test from "node:test";
import assert from "node:assert/strict";
import { assertIdentityMatches, normalizeSocialHandle } from "../dist/domain/browser-identity.js";

test("real platform profile hrefs normalize to the configured handle", () => {
  assert.equal(normalizeSocialHandle("/flerdvision/"), "flerdvision");
  assert.equal(normalizeSocialHandle("/@flerdvision"), "flerdvision");
  assert.equal(assertIdentityMatches("@Flerdvision", "/flerdvision/"), true);
  assert.equal(assertIdentityMatches("flerdvision", "/@flerdvision"), true);
});
