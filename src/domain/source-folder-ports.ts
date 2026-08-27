import type { SourceFolderListing, SourceFolderPreview } from "./source-folder.js";

export interface SourceFolderBrowserPort {
  /** `folderId` may be the provider's root alias; the adapter resolves what that means. */
  listFolder(folderId: string): Promise<SourceFolderListing>;
  previewFolder(folderId: string): Promise<SourceFolderPreview>;
}

export interface SourceFolderTechnicalSelection {
  /** Stable technical locator stored in SourceLane.folderRef. Never a display breadcrumb. */
  folderRef: string;
}

/**
 * Converts the picker's opaque provider token into the exact technical SourceLane locator.
 * Drive returns a validated folder id; local mounts decode and confine the token to their root.
 * UI code must never derive this value from folderPath/display text.
 */
export interface SourceFolderSelectionResolverPort {
  resolveSelectedFolder(folderId: string): Promise<SourceFolderTechnicalSelection>;
}

/**
 * Supplies a short-lived access token. Kept separate from the browser so that how a deployment
 * obtains credentials never leaks into how folders are read.
 */
export interface SourceAccessTokenPort {
  accessToken(): Promise<string>;
}

export interface HttpJsonResponse {
  status: number;
  body: unknown;
}

/** Injected so the Drive adapter is testable without network access. */
export interface HttpJsonPort {
  getJson(url: string, headers: Readonly<Record<string, string>>): Promise<HttpJsonResponse>;
  postForm(url: string, form: Readonly<Record<string, string>>): Promise<HttpJsonResponse>;
}
