import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoogleDriveFolderIngressAdapter } from "../dist/adapters/ingress/google-drive.js";
import { GoogleDriveAppPropertiesDispositionAdapter } from "../dist/adapters/disposition/adapters.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";

const FOLDER = "application/vnd.google-apps.folder";

class FakeDriveReadClient {
  constructor(tree) { this.tree = tree; }
  async listChildren(folderId, pageToken) {
    assert.equal(pageToken, undefined);
    return { files: this.tree[folderId] ?? [] };
  }
}

test("Drive read-only adapter recursively discovers only accepted media and preserves path metadata", async () => {
  const client = new FakeDriveReadClient({
    root: [
      { id: "c1", name: "06_ExampleCreator", mimeType: FOLDER },
      { id: "images", name: "Bilder", mimeType: FOLDER }
    ],
    c1: [{ id: "week", name: "KW_35", mimeType: FOLDER }],
    week: [{ id: "day", name: "03_Mittwoch", mimeType: FOLDER }],
    day: [
      { id: "video", name: "clip.mp4", mimeType: "video/mp4", md5Checksum: "abc", size: "123" },
      { id: "txt", name: "caption.txt", mimeType: "text/plain", size: "5" }
    ],
    images: [{ id: "jpg", name: "cover.jpg", mimeType: "image/jpeg", md5Checksum: "img" }]
  });
  const adapter = new GoogleDriveFolderIngressAdapter(client, {
    sourceId: "current_google_drive",
    rootFolderId: "root",
    observedAt: () => "2026-08-26T08:00:00Z"
  });

  const observations = await adapter.observe();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].externalObjectId, "video");
  assert.equal(observations[0].metadata.relativePath, "06_ExampleCreator/KW_35/03_Mittwoch/clip.mp4");
  assert.equal(observations[0].mediaFingerprint, "drive-md5:abc");
  assert.equal(observations[0].locator, "gdrive://file/video");
});

test("Drive disposition adapter is optional and writes only appProperties when explicitly wired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-drive-disposition-"));
  const store = new SqliteControlPlaneStore(join(dir, "test.sqlite"));
  try {
    store.observeOrGetSource({
      observationId: "obs:drive:1",
      sourceId: "drive",
      externalObjectId: "file-1",
      observedAt: "2026-08-26T08:00:00Z",
      locator: "gdrive://file/file-1",
      mediaFingerprint: "drive-md5:a",
      metadata: { driveFileId: "file-1", relativePath: "Creator/KW/01_Montag/a.mp4" }
    }, "2026-08-26T08:00:01Z", { type: "test", id: "seed" });

    const calls = [];
    const drive = { async setAppProperties(fileId, properties) { calls.push({ fileId, properties }); } };
    const adapter = new GoogleDriveAppPropertiesDispositionAdapter(store, drive);
    await adapter.markCompleted("obs:drive:1", ["pub:b", "pub:a"]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].fileId, "file-1");
    assert.equal(calls[0].properties["flerdvision.status"], "completed");
    assert.equal(calls[0].properties["flerdvision.publication_ids"], "pub:a,pub:b");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("Drive adapter follows pagination without changing observation identity", async () => {
  const calls = [];
  const client = {
    async listChildren(folderId, pageToken) {
      calls.push({ folderId, pageToken });
      if (!pageToken) {
        return {
          files: [{ id: "v1", name: "one.mp4", mimeType: "video/mp4", md5Checksum: "1" }],
          nextPageToken: "p2"
        };
      }
      return { files: [{ id: "v2", name: "two.mp4", mimeType: "video/mp4", md5Checksum: "2" }] };
    }
  };
  const adapter = new GoogleDriveFolderIngressAdapter(client, {
    sourceId: "drive", rootFolderId: "root", observedAt: () => "2026-08-26T08:00:00Z"
  });
  const observations = await adapter.observe();
  assert.equal(observations.length, 2);
  assert.deepEqual(calls, [{ folderId: "root", pageToken: undefined }, { folderId: "root", pageToken: "p2" }]);
  assert.notEqual(observations[0].observationId, observations[1].observationId);
});

test("Google Drive REST read client sends read-only list request with auth and paging", async () => {
  const { GoogleDriveRestReadClient } = await import("../dist/adapters/ingress/google-drive.js");
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ files: [{ id: "a", name: "a.mp4", mimeType: "video/mp4" }], nextPageToken: "next" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const client = new GoogleDriveRestReadClient({ async getAccessToken() { return "token-123"; } }, "https://drive.invalid/v3");
    const page = await client.listChildren("folder-1", "page-2");
    assert.equal(page.files.length, 1);
    assert.equal(page.nextPageToken, "next");
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /^https:\/\/drive\.invalid\/v3\/files\?/);
    assert.match(seen[0].url, /pageToken=page-2/);
    assert.match(new URL(seen[0].url).searchParams.get('q') ?? '', /'folder-1' in parents/);
    assert.equal(seen[0].init.method, "GET");
    assert.equal(seen[0].init.headers.Authorization, "Bearer token-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google Drive REST disposition client PATCHes only appProperties", async () => {
  const { GoogleDriveRestWriteClient } = await import("../dist/adapters/disposition/google-drive-rest.js");
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new GoogleDriveRestWriteClient({ async getAccessToken() { return "token-456"; } }, "https://drive.invalid/v3");
    await client.setAppProperties("file/1", { "flerdvision.status": "completed" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://drive.invalid/v3/files/file%2F1?supportsAllDrives=true");
    assert.equal(seen[0].init.method, "PATCH");
    assert.deepEqual(JSON.parse(seen[0].init.body), { appProperties: { "flerdvision.status": "completed" } });
    assert.equal(seen[0].init.headers.Authorization, "Bearer token-456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
