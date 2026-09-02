import test from "node:test";
import assert from "node:assert/strict";
import { filenameParts } from "../dist/adapters/publish/workspace-payload-resolver.js";

// Luca writes the caption into the Drive filename and puts the hashtags in there too. One name
// therefore has to serve both a platform that wants tags (TikTok) and one that must not show
// them (Instagram), so the resolver splits it instead of the operator maintaining two copies.

test("the wording and the hashtags come out of one filename", () => {
  const parts = filenameParts("Sonnenuntergang am See #nature #chill.mp4");
  assert.equal(parts.text, "Sonnenuntergang am See");
  assert.equal(parts.hashtags, "#nature #chill");
});

test("a name without hashtags yields empty tags and untouched wording", () => {
  const parts = filenameParts("flerdvision-test-reel-01.mp4");
  assert.equal(parts.text, "flerdvision-test-reel-01");
  assert.equal(parts.hashtags, "");
});

test("hashtags in the middle are removed from the wording without leaving double spaces", () => {
  assert.equal(filenameParts("Morgens #fyp am Meer.mov").text, "Morgens am Meer");
});

test("only a real extension is stripped, never a trailing word", () => {
  assert.equal(filenameParts("Rezept Nr. 4 Pasta").text, "Rezept Nr. 4 Pasta");
  assert.equal(filenameParts("clip.final.mp4").text, "clip.final");
});
