import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

// Live evidence 2026-09-01: Studio blocks its whole wizard on "Wurde dieses Video speziell für
// Kinder erstellt? (erforderlich)" -- Continue stays disabled until it is answered. It is a legal
// statement about the content, so the system must never answer it on the operator's behalf.

const settings = readFileSync(new URL("../src/adapters/browser/autonomous-surface-settings.ts", import.meta.url).pathname, "utf8");

test("the declaration has no default and stops the run when unstated", () => {
  const idx = settings.indexOf("Studio's mandatory audience question blocks");
  const block = settings.slice(idx, idx + 900);
  assert.match(block, /madeForKids === undefined/);
  assert.match(block, /set settings\.madeForKids in the canonical spec/);
});

test("the answer clicked is exactly the one the operator declared", () => {
  const idx = settings.indexOf("private async ensureAudience");
  const block = settings.slice(idx, idx + 1400);
  assert.match(block, /"Ja, es ist speziell für Kinder"/);
  assert.match(block, /"Nein, es ist nicht speziell für Kinder"/);
  assert.match(block, /input\.madeForKids\s*\n?\s*\? \["Ja/);
});

test("the declaration is proven by readback, never assumed", () => {
  const idx = settings.indexOf("private async ensureAudience");
  const block = settings.slice(idx, idx + 2000);
  assert.match(block, /aria-checked"\) === "true"/);
  assert.match(block, /did not take: expected/);
});

test("the spec accepts madeForKids for youtube and refuses it elsewhere", () => {
  const base = { schemaVersion: 1, workspace: { id: "w", name: "W", ownerEmail: "a@b.c", timezone: "Europe/Vienna", runtimeRoot: "runtime" }, source: { kind: "google_drive", root: "https://drive.google.com/drive/folders/x" } };
  const yt = parseWorkspaceSpec({ ...base, channels: [{ key: "yt", name: "YT", platform: "youtube", handle: "h", formats: [{ type: "short", times: ["09:00"], sourceMatch: ["x"], settings: { visibility: "private", madeForKids: false } }] }] });
  assert.equal(yt.channels[0].formats[0].settings.madeForKids, false);
  assert.throws(() => parseWorkspaceSpec({ ...base, channels: [{ key: "ig", name: "IG", platform: "instagram", handle: "h", formats: [{ type: "reel", times: ["09:00"], sourceMatch: ["x"], settings: { madeForKids: false } }] }] }), /not valid for instagram/);
});

test("the declaration is answered before the wizard is walked", () => {
  const explorer = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  // Continue stays disabled until the question is answered, so answering it after the walk
  // meant the walk never moved and the final control was never reachable.
  const audience = explorer.indexOf('stepKey: "AUDIENCE"');
  const wizard = explorer.indexOf("Wizard surfaces put the final control");
  assert.ok(audience > 0 && audience < wizard, "the declaration must precede the wizard walk");
  assert.match(explorer, /set settings\.madeForKids in the canonical spec/);
});

test("the two answers are told apart by an unambiguous discriminator", () => {
  const explorer = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  const idx = explorer.indexOf("Exact-name matching kept missing this one");
  const block = explorer.slice(idx, idx + 2200);
  // Both answers contain "speziell für Kinder"; only the negation separates them.
  assert.match(block, /text\.includes\("nicht"\) \|\| text\.startsWith\("no,"\) \|\| text\.includes\("not made"\)/);
  assert.match(block, /isNegative === negative/);
  // The smallest match wins so a wrapper containing both answers can never be clicked.
  assert.match(block, /matches\.sort\(\(left, right\) =>/);
  assert.match(block, /text\.length > 80/);
});
