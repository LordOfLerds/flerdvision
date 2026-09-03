import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { WorkspacePublicationPayloadResolver } from "../dist/adapters/publish/workspace-payload-resolver.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { WorkspaceSpecCompiler } from "../dist/application/workspace-spec-compiler.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

// The caption lives in the Drive filename, hashtags included. The shipped example spec must
// therefore express the per-platform rule (Instagram: wording only, TikTok: wording plus tags,
// YouTube: wording as title) with the filename variables the resolver already provides -- and
// the whole chain, example -> compiler -> copy payload -> resolver, has to accept them. This
// renders the real example through the real code, so a template typo in the example cannot
// survive until a live qualification finds it.

const FILENAME = "01_Testwelle Mo 0930 TikTok #flerdvision #test.mp4";
const CONTENT_ID = "content:testwelle-01";

function exampleSpec() {
  const raw = JSON.parse(readFileSync(new URL("../config/flerdvision.example.json", import.meta.url), "utf8"));
  return parseWorkspaceSpec(raw);
}

function topologyFor(spec) {
  const nodes = [{ folderId: "root", folderRef: "root", folderPath: "Drive / Flerdvision", name: "Flerdvision", depth: 0, directVideoCount: 0, totalVideoCount: 3, childFolderCount: 3 }];
  const streams = [];
  for (const channel of spec.channels) {
    for (const format of channel.formats) {
      const folderId = `folder-${channel.key}`;
      nodes.push({ folderId, folderRef: folderId, folderPath: `Drive / Flerdvision / ${channel.name}`, name: channel.name, depth: 1, directVideoCount: 1, totalVideoCount: 1, childFolderCount: 0 });
      streams.push({ channelKey: channel.key, platform: channel.platform, format: format.type, folderRef: folderId, folderPath: `Drive / Flerdvision / ${channel.name}`, totalVideoCount: 1, matchedBy: "explicit", score: 30 });
    }
  }
  return { rootId: "root", rootPath: "Drive / Flerdvision", nodes, streams, warnings: [], verified: true };
}

const store = {
  getContentItem(id) {
    if (id !== CONTENT_ID) return null;
    return { item: { contentId: id, acceptedFromObservationId: "obs", creatorId: "creator:1", mediaFingerprint: "fp", immutableMediaRef: "file:///tmp/x.mp4", metadata: { fileName: FILENAME } }, createdAt: "2026-09-03T08:00:00Z" };
  }
};

async function renderedPayloads() {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-filename-templates-"));
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const config = new JsonDistributionConfigurationStore(join(configDir, "distribution.json"));
  const control = new SqliteControlPlaneStore(join(root, "flerdvision.sqlite"));
  try {
    const spec = exampleSpec();
    const report = new WorkspaceSpecCompiler(config, control, configDir).compile(spec, topologyFor(spec), "2026-09-03T08:00:00Z");
    assert.equal(report.routes, spec.channels.length, "the example compiles one route per channel");
    const stored = config.load();
    const resolver = new WorkspacePublicationPayloadResolver(join(configDir, "copy-payloads.json"), store);
    const out = {};
    for (const route of stored.config.routes) {
      const copy = stored.config.copyProfiles.find((item) => item.copyProfileId === route.copyProfileId);
      const profile = stored.config.postingProfiles.find((item) => item.postingProfileId === route.postingProfileId);
      out[route.platform] = await resolver.resolve({
        intentId: `intent:${route.platform}`, contentId: CONTENT_ID, creatorId: "creator:1", platform: route.platform, accountId: route.accountId,
        format: profile.format, copyVersionId: copy.versionId, scheduledFor: "2026-09-03T10:00:00Z", idempotencyKey: `idem:${route.platform}`
      });
    }
    return out;
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}

test("the example spec names every platform's filename template with the resolver's variables", () => {
  const spec = exampleSpec();
  const byPlatform = Object.fromEntries(spec.channels.map((channel) => [channel.platform, channel.formats[0]]));
  assert.equal(byPlatform.instagram.captionTemplate, "{filenameText}\n\n[FV:{contentId}]");
  assert.equal(byPlatform.tiktok.captionTemplate, "{filenameText} {filenameHashtags}\n\n[FV:{contentId}]");
  assert.equal(byPlatform.youtube.titleTemplate, "{filenameText}");
  assert.equal(byPlatform.youtube.descriptionTemplate, "{filenameHashtags}");
  for (const format of Object.values(byPlatform)) {
    for (const template of [format.captionTemplate, format.titleTemplate, format.descriptionTemplate]) {
      if (template !== undefined) assert.doesNotMatch(template, /\{filename\}/, "the raw filename carries the sort prefix and the extension; the example must not post it");
    }
  }
});

test("Instagram gets the wording without hashtags, TikTok the wording with them, YouTube the wording as title", async () => {
  const payloads = await renderedPayloads();
  assert.equal(payloads.instagram.caption, `Testwelle Mo 0930 TikTok\n\n[FV:${CONTENT_ID}]`);
  assert.doesNotMatch(payloads.instagram.caption, /#/);
  assert.equal(payloads.tiktok.caption, `Testwelle Mo 0930 TikTok #flerdvision #test\n\n[FV:${CONTENT_ID}]`);
  assert.equal(payloads.youtube.title, "Testwelle Mo 0930 TikTok");
  assert.equal(payloads.youtube.description, "#flerdvision #test");
  assert.equal(payloads.youtube.caption, undefined, "youtube has no caption field");
  for (const payload of Object.values(payloads)) {
    for (const value of [payload.caption, payload.title, payload.description]) {
      if (value !== undefined) assert.doesNotMatch(value, /^01_|\.mp4/, "sort prefix and extension never reach a platform");
    }
  }
});

test("the marker stays on the caption exactly while verificationMarker is true", async () => {
  const spec = exampleSpec();
  const payloads = await renderedPayloads();
  for (const channel of spec.channels) {
    const payload = payloads[channel.platform];
    const text = payload.caption ?? payload.title;
    if (channel.formats[0].verificationMarker) assert.match(text, /\[FV:content:testwelle-01\]$/);
    else assert.doesNotMatch(text, /\[FV:/);
  }
});
