import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { SourceObservation } from "../../domain/model.js";
import type { SourceConnection, SourceLane } from "../../domain/distribution.js";
import type { SourceLaneObservationPort } from "../../domain/source-lane-runtime.js";
import { GoogleDriveFolderIngressAdapter, type GoogleDriveReadClient } from "./google-drive.js";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".webm"] as const;

function observationId(sourceId: string, externalObjectId: string): string {
  return `source:${createHash("sha256").update(`${sourceId}\n${externalObjectId}`).digest("hex").slice(0, 32)}`;
}
function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = new Uint8Array(1024 * 1024);
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
  return hash.digest("hex");
}
function inside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const absolute = resolve(candidate);
  if (absolute !== resolvedRoot && !absolute.startsWith(resolvedRoot + sep)) {
    throw new Error(`Local lane path escapes source root: ${candidate}`);
  }
  return absolute;
}
function accepts(name: string): boolean {
  const lower = name.toLocaleLowerCase("en-US");
  return VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface SourceLaneObservationAdapterOptions {
  googleDriveClient?: GoogleDriveReadClient;
  localMaxDepth?: number;
}

export class SourceLaneObservationAdapter implements SourceLaneObservationPort {
  constructor(private readonly options: SourceLaneObservationAdapterOptions = {}) {}

  async observeLane(source: SourceConnection, lane: SourceLane, now: string): Promise<readonly SourceObservation[]> {
    const sourceId = `lane:${lane.laneId}`;
    if (source.kind === "google_drive") {
      if (!this.options.googleDriveClient) throw new Error(`Google Drive client is not configured for lane ${lane.laneId}`);
      const rootLabel = lane.interpretation.kind === "creator_week_day" ? lane.interpretation.creatorAlias : undefined;
      const adapter = new GoogleDriveFolderIngressAdapter(this.options.googleDriveClient, {
        sourceId,
        rootFolderId: lane.folderRef,
        ...(rootLabel ? { rootLabel } : {}),
        observedAt: () => new Date(now).toISOString()
      });
      const observed = await adapter.observe();
      return observed.map((item) => ({ ...item, metadata: { ...item.metadata, connectionId: source.connectionId, laneId: lane.laneId } }));
    }
    if (source.kind !== "local_folder") throw new Error(`Unsupported source kind: ${source.kind}`);
    return this.observeLocal(source, lane, sourceId, now);
  }

  private observeLocal(source: SourceConnection, lane: SourceLane, sourceId: string, now: string): readonly SourceObservation[] {
    // folderRef is the technical source-relative locator; folderPath is display-only metadata.
    const root = inside(source.rootRef, join(source.rootRef, lane.folderRef));
    const maxDepth = this.options.localMaxDepth ?? 8;
    const out: SourceObservation[] = [];
    const walk = (directory: string, relativeSegments: readonly string[], depth: number): void => {
      if (depth > maxDepth) throw new Error(`Local lane traversal exceeded maxDepth=${maxDepth}`);
      for (const name of readdirSync(directory).sort()) {
        const path = inside(root, join(directory, name));
        const stats = statSync(path);
        const nextSegments = [...relativeSegments, name];
        if (stats.isDirectory()) { walk(path, nextSegments, depth + 1); continue; }
        if (!stats.isFile() || !accepts(name)) continue;
        const relativePath = nextSegments.join("/");
        const externalObjectId = relativePath;
        const sha256 = fileSha256(path);
        out.push({
          observationId: observationId(sourceId, externalObjectId),
          sourceId,
          externalObjectId,
          observedAt: new Date(now).toISOString(),
          locator: new URL(`file://${path}`).toString(),
          mediaFingerprint: `local-sha256:${sha256}`,
          metadata: {
            connectionId: source.connectionId,
            laneId: lane.laneId,
            relativePath,
            fileName: name,
            size: String(stats.size),
            modifiedTime: stats.mtime.toISOString(),
            localPath: path,
            displayLanePath: lane.folderPath
          }
        });
      }
    };
    walk(root, [], 0);
    return out.sort((a, b) => (a.metadata.relativePath ?? "").localeCompare(b.metadata.relativePath ?? ""));
  }
}
