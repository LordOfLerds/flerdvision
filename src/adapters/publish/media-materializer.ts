import { createHash } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ContentItem } from "../../domain/model.js";
import type { LocalMediaArtifact } from "../../domain/platform-ui.js";
import type { MediaMaterializerPort } from "../../domain/platform-ui-ports.js";
import type { AccessTokenProvider } from "../ingress/google-drive.js";

export class MediaMaterializationError extends Error {}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = new Uint8Array(1024 * 1024);
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count <= 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function ensureWithinRoot(path: string, root: string): string {
  const absolute = resolve(path);
  const resolvedRoot = resolve(root);
  if (absolute !== resolvedRoot && !absolute.startsWith(resolvedRoot + sep)) {
    throw new MediaMaterializationError(`Media path escapes allowed root: ${path}`);
  }
  return absolute;
}

export interface LocalFileMediaMaterializerConfig {
  allowedRoot: string;
}

export class LocalFileMediaMaterializer implements MediaMaterializerPort {
  constructor(private readonly config: LocalFileMediaMaterializerConfig) {}

  async materialize(content: ContentItem): Promise<LocalMediaArtifact> {
    const ref = content.immutableMediaRef;
    let path: string;
    if (ref.startsWith("file://")) path = decodeURIComponent(new URL(ref).pathname);
    else if (ref.startsWith("local://")) path = join(this.config.allowedRoot, ref.slice("local://".length));
    else throw new MediaMaterializationError(`Unsupported local media ref: ${ref}`);
    const localPath = ensureWithinRoot(path, this.config.allowedRoot);
    const stats = statSync(localPath);
    if (!stats.isFile()) throw new MediaMaterializationError(`Media is not a regular file: ${localPath}`);
    return {
      contentId: content.contentId,
      sourceRef: ref,
      localPath,
      sha256: sha256File(localPath),
      sizeBytes: stats.size
    };
  }
}

export interface GoogleDriveMediaMaterializerConfig {
  cacheRoot: string;
  baseUrl?: string;
}

function driveFileId(ref: string): string {
  const match = /^gdrive:\/\/file\/([^/?#]+)$/.exec(ref);
  if (!match?.[1]) throw new MediaMaterializationError(`Unsupported Google Drive media ref: ${ref}`);
  return decodeURIComponent(match[1]);
}

export class GoogleDriveRestMediaMaterializer implements MediaMaterializerPort {
  private readonly cacheRoot: string;
  private readonly baseUrl: string;

  constructor(
    private readonly tokenProvider: AccessTokenProvider,
    config: GoogleDriveMediaMaterializerConfig
  ) {
    this.cacheRoot = resolve(config.cacheRoot);
    this.baseUrl = config.baseUrl ?? "https://www.googleapis.com/drive/v3";
    mkdirSync(this.cacheRoot, { recursive: true, mode: 0o700 });
  }

  async materialize(content: ContentItem): Promise<LocalMediaArtifact> {
    const fileId = driveFileId(content.immutableMediaRef);
    const token = await this.tokenProvider.getAccessToken();
    const name = content.metadata.fileName ? basename(content.metadata.fileName) : `${fileId}.bin`;
    const directory = join(this.cacheRoot, content.contentId.replace(/[^a-zA-Z0-9._-]/g, "_"));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const finalPath = join(directory, name);
    const tempPath = `${finalPath}.partial-${Math.random().toString(36).slice(2, 10)}`;

    const response = await fetch(`${this.baseUrl}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok || !response.body) throw new MediaMaterializationError(`Google Drive media download failed: HTTP ${response.status}`);

    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath, { mode: 0o600 }));
      renameSync(tempPath, finalPath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }

    const stats = statSync(finalPath);
    return {
      contentId: content.contentId,
      sourceRef: content.immutableMediaRef,
      localPath: finalPath,
      sha256: sha256File(finalPath),
      sizeBytes: stats.size
    };
  }

  async release(artifact: LocalMediaArtifact): Promise<void> {
    const absolute = ensureWithinRoot(artifact.localPath, this.cacheRoot);
    rmSync(absolute, { force: true });
  }
}
