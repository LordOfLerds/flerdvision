import test from "node:test";
import assert from "node:assert/strict";
import { sourceMatchWarnings } from "../dist/application/headless-bootstrap.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

// Goal C: a channel added by someone with no chat context is exactly the case where a typo'd or
// not-yet-created sourceMatch token silently falls back to a semantic/root guess. Discovery
// itself (source-structure-discovery.ts) only warns when NO folder scored at all; it never says
// "your explicit sourceMatch specifically missed" when a looser platform/format/name heuristic
// happened to save the day. bootstrapHeadlessWorkspace must turn that silent fallback into a
// warning naming the channel, the format and the exact tokens that did not match.

function spec(sourceMatch) {
  return parseWorkspaceSpec({
    schemaVersion: 1,
    workspace: { id: "ws", name: "WS", ownerEmail: "info@flerdvision.com", timezone: "Europe/Vienna", runtimeRoot: "runtime" },
    source: { kind: "google_drive", root: "https://drive.google.com/drive/folders/0123456789abcdef", structure: "auto", activation: "IMPORT_BACKLOG", maxDepth: 4 },
    channels: [{
      key: "flerdvision-4",
      name: "Flerdvision Channel 4",
      platform: "youtube",
      handle: "flerdvision4",
      formats: [{ type: "short", sourceMatch, titleTemplate: "{filenameText}", requirement: "REQUIRED", verificationMarker: false, settings: { visibility: "private", madeForKids: false } }]
    }]
  });
}

function topology(matchedBy, verified = true) {
  return {
    rootId: "root", rootPath: "Drive / Flerdvision", nodes: [], warnings: [], verified,
    streams: [{ channelKey: "flerdvision-4", platform: "youtube", format: "short", folderRef: "f1", folderPath: "Drive / Flerdvision / Misc", totalVideoCount: 3, matchedBy, score: matchedBy === "root_fallback" ? 0 : 12 }]
  };
}

test("an explicit sourceMatch that never contributed to the winning folder produces a named warning", () => {
  const warnings = sourceMatchWarnings(spec(["therapie"]), topology("semantic"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /flerdvision-4\/short/);
  assert.match(warnings[0], /therapie/);
});

test("a root fallback also warns and says the root was used", () => {
  const warnings = sourceMatchWarnings(spec(["therapie"]), topology("root_fallback"));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /source root/);
});

test("an explicit match that actually won produces no warning", () => {
  const warnings = sourceMatchWarnings(spec(["youtube"]), topology("explicit"));
  assert.equal(warnings.length, 0);
});

test("a format with no sourceMatch tokens at all is never warned about", () => {
  const warnings = sourceMatchWarnings(spec([]), topology("semantic"));
  assert.equal(warnings.length, 0);
});

test("an unverified topology (e.g. Drive not authenticated yet) never produces a sourceMatch warning", () => {
  const warnings = sourceMatchWarnings(spec(["therapie"]), topology("root_fallback", false));
  assert.equal(warnings.length, 0);
});
