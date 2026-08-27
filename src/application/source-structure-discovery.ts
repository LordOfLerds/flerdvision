import type { SourceFolderBrowserPort, SourceFolderSelectionResolverPort } from "../domain/source-folder-ports.js";
import type { WorkspaceChannelFormatSpec, WorkspaceChannelSpec } from "../domain/workspace-spec.js";

export interface SourceTopologyNode {
  folderId: string;
  folderRef: string;
  folderPath: string;
  name: string;
  depth: number;
  directVideoCount: number;
  totalVideoCount: number;
  childFolderCount: number;
}

export interface SourceStreamSelection {
  channelKey: string;
  platform: WorkspaceChannelSpec["platform"];
  format: WorkspaceChannelFormatSpec["type"];
  folderRef: string;
  folderPath: string;
  totalVideoCount: number;
  matchedBy: "explicit" | "semantic" | "root_fallback";
  score: number;
}

export interface SourceTopology {
  rootId: string;
  rootPath: string;
  nodes: readonly SourceTopologyNode[];
  streams: readonly SourceStreamSelection[];
  warnings: readonly string[];
  verified: boolean;
}

export class SourceStructureDiscoveryError extends Error {}

function words(value: string): readonly string[] {
  return [...new Set(value.toLocaleLowerCase("en-US").split(/[^a-z0-9äöüß]+/).filter((part) => part.length > 1))];
}
function includesToken(pathTokens: ReadonlySet<string>, token: string): boolean {
  const normalized = token.toLocaleLowerCase("en-US").replace(/^@/, "").trim();
  if (!normalized) return false;
  if (pathTokens.has(normalized)) return true;
  return [...pathTokens].some((candidate) => candidate.includes(normalized) || normalized.includes(candidate));
}
function formatTokens(format: WorkspaceChannelFormatSpec["type"]): readonly string[] {
  if (format === "trial_reel") return ["trial", "test", "trialreel", "testreel", "reel"];
  if (format === "reel") return ["reel", "reels", "instagram"];
  if (format === "story") return ["story", "stories", "instagram"];
  if (format === "tiktok") return ["tiktok", "video", "videos"];
  return ["short", "shorts", "youtube"];
}
function platformTokens(platform: WorkspaceChannelSpec["platform"]): readonly string[] {
  if (platform === "instagram") return ["instagram", "insta", "ig"];
  if (platform === "tiktok") return ["tiktok", "tik", "tt"];
  return ["youtube", "yt"];
}

function scoreNode(node: SourceTopologyNode, channel: WorkspaceChannelSpec, format: WorkspaceChannelFormatSpec): { score: number; explicit: boolean } {
  const pathTokens = new Set(words(node.folderPath));
  let score = 0;
  let explicit = false;
  for (const token of format.sourceMatch) {
    if (includesToken(pathTokens, token)) { score += 30; explicit = true; }
  }
  for (const token of platformTokens(channel.platform)) if (includesToken(pathTokens, token)) score += 7;
  for (const token of formatTokens(format.type)) if (includesToken(pathTokens, token)) score += 10;
  for (const token of [...words(channel.name), ...words(channel.handle), ...words(channel.key)]) if (includesToken(pathTokens, token)) score += 4;
  if (node.directVideoCount > 0) score += 2;
  score -= Math.max(0, node.depth - 1);
  return { score, explicit };
}

function selectStreams(nodes: readonly SourceTopologyNode[], channels: readonly WorkspaceChannelSpec[]): { streams: SourceStreamSelection[]; warnings: string[] } {
  const warnings: string[] = [];
  const streams: SourceStreamSelection[] = [];
  const root = nodes.find((node) => node.depth === 0);
  if (!root) throw new SourceStructureDiscoveryError("Source topology has no root node");
  const viable = nodes.filter((node) => node.totalVideoCount > 0);
  for (const channel of channels) {
    for (const format of channel.formats) {
      const ranked = viable.map((node) => ({ node, ...scoreNode(node, channel, format) }))
        .sort((a, b) => b.score - a.score || a.node.depth - b.node.depth || b.node.totalVideoCount - a.node.totalVideoCount || a.node.folderPath.localeCompare(b.node.folderPath));
      const best = ranked[0];
      const semantic = best && best.score > 0 ? best : undefined;
      const chosen = semantic?.node ?? root;
      const tied = semantic ? ranked.filter((entry) => entry.score === semantic.score && entry.node.folderId !== semantic.node.folderId) : [];
      if (tied.length > 0) warnings.push(`${channel.key}/${format.type}: several source folders had the same score; selected ${chosen.folderPath}`);
      if (!semantic) warnings.push(`${channel.key}/${format.type}: no semantic folder match; using the supplied root ${root.folderPath}`);
      streams.push({
        channelKey: channel.key,
        platform: channel.platform,
        format: format.type,
        folderRef: chosen.folderRef,
        folderPath: chosen.folderPath,
        totalVideoCount: chosen.totalVideoCount,
        matchedBy: semantic ? (semantic.explicit ? "explicit" : "semantic") : "root_fallback",
        score: semantic?.score ?? 0
      });
    }
  }
  return { streams, warnings };
}

export function extractGoogleDriveFolderId(input: string): string {
  const value = input.trim();
  if (!value) throw new SourceStructureDiscoveryError("Google Drive folder link/id is empty");
  if (/^[a-zA-Z0-9_-]{10,}$/.test(value)) return value;
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new SourceStructureDiscoveryError("Google Drive source must be a folder URL or stable folder id"); }
  const host = parsed.hostname.replace(/^www\./, "").toLocaleLowerCase("en-US");
  if (host !== "drive.google.com") throw new SourceStructureDiscoveryError(`Unsupported Drive host: ${host}`);
  const folderMatch = /\/folders\/([a-zA-Z0-9_-]+)/.exec(parsed.pathname);
  const id = folderMatch?.[1] ?? parsed.searchParams.get("id") ?? "";
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) throw new SourceStructureDiscoveryError("Could not extract a stable Google Drive folder id from the link");
  return id;
}

export function unverifiedRootTopology(input: { rootId: string; rootPath: string; folderRef: string; channels: readonly WorkspaceChannelSpec[]; reason: string }): SourceTopology {
  const root: SourceTopologyNode = { folderId: input.rootId, folderRef: input.folderRef, folderPath: input.rootPath, name: input.rootPath, depth: 0, directVideoCount: 0, totalVideoCount: 0, childFolderCount: 0 };
  const streams = input.channels.flatMap((channel) => channel.formats.map((format): SourceStreamSelection => ({
    channelKey: channel.key, platform: channel.platform, format: format.type, folderRef: input.folderRef, folderPath: input.rootPath,
    totalVideoCount: 0, matchedBy: "root_fallback", score: 0
  })));
  return { rootId: input.rootId, rootPath: input.rootPath, nodes: [root], streams, warnings: [input.reason], verified: false };
}

export async function discoverSourceTopology(input: {
  browser: SourceFolderBrowserPort;
  resolver?: SourceFolderSelectionResolverPort;
  rootId: string;
  providerKind: "google_drive" | "local_folder";
  channels: readonly WorkspaceChannelSpec[];
  maxDepth: number;
  maxFolders?: number;
}): Promise<SourceTopology> {
  const nodes: SourceTopologyNode[] = [];
  const maxFolders = input.maxFolders ?? 200;
  const visit = async (folderId: string, depth: number): Promise<{ totalVideos: number; path: string }> => {
    if (nodes.length >= maxFolders) throw new SourceStructureDiscoveryError(`Source discovery exceeded ${maxFolders} folders`);
    const listing = await input.browser.listFolder(folderId);
    if (listing.truncated) throw new SourceStructureDiscoveryError(`Folder ${listing.folderName} is truncated; narrow the source root before autonomous discovery`);
    const preview = await input.browser.previewFolder(folderId);
    const childIds = listing.entries.filter((entry) => entry.kind === "folder").map((entry) => entry.id);
    let childVideos = 0;
    if (depth < input.maxDepth) {
      for (const childId of childIds) childVideos += (await visit(childId, depth + 1)).totalVideos;
    }
    const folderRef = input.providerKind === "google_drive"
      ? folderId
      : folderId === "root" ? "." : (await input.resolver?.resolveSelectedFolder(folderId))?.folderRef;
    if (!folderRef) throw new SourceStructureDiscoveryError(`Could not resolve technical source folder ${folderId}`);
    const folderPath = listing.path.map((crumb) => crumb.name).join(" / ");
    const totalVideos = preview.videoCount + childVideos;
    nodes.push({
      folderId,
      folderRef,
      folderPath,
      name: listing.folderName,
      depth,
      directVideoCount: preview.videoCount,
      totalVideoCount: totalVideos,
      childFolderCount: childIds.length
    });
    return { totalVideos, path: folderPath };
  };
  const rootResult = await visit(input.rootId, 0);
  nodes.sort((a, b) => a.depth - b.depth || a.folderPath.localeCompare(b.folderPath));
  const selected = selectStreams(nodes, input.channels);
  if (rootResult.totalVideos === 0) selected.warnings.push("No video was found below the supplied source root during discovery");
  return { rootId: input.rootId, rootPath: rootResult.path, nodes, streams: selected.streams, warnings: selected.warnings, verified: true };
}
