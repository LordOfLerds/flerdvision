import test from "node:test";
import assert from "node:assert/strict";
import { discoverSourceTopology, extractGoogleDriveFolderId } from "../dist/application/source-structure-discovery.js";
import { parseWorkspaceSpec } from "../dist/domain/workspace-spec.js";

const tree = {
  root: { name: "Flerdvision", parent: null, children: ["ig", "tt"], videos: 0 },
  ig: { name: "Instagram Reels", parent: "root", children: [], videos: 4 },
  tt: { name: "TikTok", parent: "root", children: [], videos: 3 }
};

function pathFor(id) {
  const parts = [];
  let current = id;
  while (current) { parts.unshift({ id: current, name: tree[current].name }); current = tree[current].parent; }
  return parts;
}

const browser = {
  async listFolder(id) {
    const node = tree[id];
    return {
      folderId: id,
      folderName: node.name,
      path: pathFor(id),
      entries: node.children.map((child) => ({ id: child, name: tree[child].name, kind: "folder", modifiedAt: "2026-08-27T00:00:00Z" })),
      truncated: false
    };
  },
  async previewFolder(id) {
    return { folderId: id, videoCount: tree[id].videos, otherCount: 0 };
  },
  async resolveSelectedFolder(id) {
    return { folderRef: id === "root" ? "." : id };
  }
};

function spec() {
  return parseWorkspaceSpec({
    schemaVersion: 1,
    workspace: { id: "demo", name: "Demo" },
    source: { kind: "local_folder", root: "/tmp/flerdvision", structure: "auto", activation: "IMPORT_BACKLOG" },
    channels: [
      { key: "ig", name: "Flerdvision IG", platform: "instagram", handle: "flerdvision", formats: [{ type: "reel", times: ["12:00"], sourceMatch: ["instagram", "reels"] }] },
      { key: "tt", name: "Flerdvision TikTok", platform: "tiktok", handle: "flerdvision", formats: [{ type: "tiktok", times: ["18:00"], sourceMatch: ["tiktok"] }] }
    ]
  });
}

test("one root is recursively understood and mapped to channel formats", async () => {
  const topology = await discoverSourceTopology({ browser, resolver: browser, rootId: "root", providerKind: "local_folder", channels: spec().channels, maxDepth: 4 });
  assert.equal(topology.verified, true);
  assert.equal(topology.nodes.find((node) => node.folderId === "root").folderRef, ".");
  assert.equal(topology.streams.find((stream) => stream.channelKey === "ig").folderRef, "ig");
  assert.equal(topology.streams.find((stream) => stream.channelKey === "tt").folderRef, "tt");
  assert.equal(topology.streams.every((stream) => stream.matchedBy === "explicit"), true);
});

test("a Drive folder URL is reduced to its provider-stable id", () => {
  assert.equal(extractGoogleDriveFolderId("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp"), "1AbCdEfGhIjKlMnOp");
  assert.equal(extractGoogleDriveFolderId("1AbCdEfGhIjKlMnOp"), "1AbCdEfGhIjKlMnOp");
  assert.throws(() => extractGoogleDriveFolderId("https://example.com/folders/1AbCdEfGhIjKlMnOp"), /Unsupported Drive host/);
});
