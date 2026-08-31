import type { PublicationIntent } from "../../domain/model.js";

/**
 * The single URL where the automated compose/upload surface flow starts.
 *
 * Exploration and replay MUST begin on the same document: the explorer records its opening
 * steps relative to this page, and the execution runner replays the recorded contract against
 * whatever page it navigates to first. When the two disagree the contract silently encodes the
 * asymmetry -- the TikTok-readiness review found exactly that: the explorer started on
 * /upload (where the optional OPEN_UPLOAD click is skipped because the file input is already
 * present, so no OPEN_UPLOAD step is recorded), while the runner started on the root feed,
 * where a contract without an OPEN_UPLOAD step can never find the file input. The replay would
 * fail closed, but it could never succeed either.
 *
 * TikTok bootstraps directly on /upload because that page hosts the entire compose flow;
 * Instagram's create flow is only reachable from the root shell, and YouTube's from Studio.
 */
export function surfaceExecutionBootstrapUrl(platform: PublicationIntent["platform"]): string {
  if (platform === "instagram") return "https://www.instagram.com/";
  // The public /upload path redirects into the studio; going there directly avoids a redirect
  // that left the app half-booted (evidence: a rendered "TikTok Studio" shell with no controls).
  if (platform === "tiktok") return "https://www.tiktok.com/tiktokstudio/upload";
  return "https://studio.youtube.com/";
}
