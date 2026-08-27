import type { SocialAccount } from "../domain/browser-identity.js";
import type { DistributionRoute, PostingProfile } from "../domain/distribution.js";
import type { ChannelReadiness, RouteTestReadiness } from "./control-center-read-model.js";

export type RouteTestRisk = "SAFE_LOCAL" | "PREPARE_ONLY" | "LIVE_SECRET";
export type RouteTestStatus = "PASS" | "FAIL" | "NOT_RUN" | "BLOCKED";

export interface SecretLiveEligibility {
  routeId: string;
  eligible: boolean;
  reason: string;
}

export interface RouteTestCaseView {
  testKey: "SOURCE" | "SESSION" | "IDENTITY" | "SURFACE" | "PREPARE_ONLY" | "SECRET_LIVE" | "VERIFICATION" | "CLEANUP";
  label: string;
  risk: RouteTestRisk;
  status: RouteTestStatus;
  detail: string;
}

export interface RouteTestMatrix {
  routeId: string;
  routeName: string;
  account: string;
  platform: string;
  postingProfile: string;
  overall: "READY" | "NEEDS_TEST" | "BLOCKED";
  cases: readonly RouteTestCaseView[];
}

function secretProfileDefault(profile: PostingProfile): { allowed: boolean; reason: string } {
  if (profile.platform === "tiktok") {
    return profile.visibility === "only_you"
      ? { allowed: true, reason: "TikTok visibility is Only you." }
      : { allowed: false, reason: `TikTok ${profile.visibility} is not a zero-viewer secret-live mode.` };
  }
  if (profile.platform === "youtube") {
    return profile.visibility === "private"
      ? { allowed: true, reason: "YouTube visibility is private." }
      : { allowed: false, reason: `YouTube ${profile.visibility} is not a secret-live mode.` };
  }
  if (profile.format === "trial_reel") {
    return { allowed: false, reason: "Instagram Trial Reel intentionally targets non-followers and is never zero-viewer secret-live." };
  }
  return { allowed: false, reason: "Instagram secret-live requires an explicit private-account / zero-approved-followers attestation for this route." };
}

function state(value: boolean | undefined): RouteTestStatus {
  return value === true ? "PASS" : value === false ? "FAIL" : "NOT_RUN";
}

export function buildRouteTestMatrix(input: {
  route: DistributionRoute;
  profile: PostingProfile | undefined;
  account: SocialAccount | undefined;
  channel: ChannelReadiness | undefined;
  evidence: RouteTestReadiness | undefined;
  secretEligibility?: SecretLiveEligibility;
}): RouteTestMatrix {
  const { route, profile, account, channel, evidence } = input;
  const accountLabel = account ? `@${account.expectedHandle}` : "MISSING";
  const platformCompatible = Boolean(profile && account && profile.platform === route.platform && account.platform === route.platform);
  const surfacePass = channel?.surfaceContract === "CALIBRATED";
  const preparePasses = evidence?.prepareOnlyPasses ?? 0;
  const defaultSecret = profile ? secretProfileDefault(profile) : { allowed: false, reason: "Posting profile is missing." };
  const eligibility = input.secretEligibility ?? { routeId: route.routeId, eligible: defaultSecret.allowed, reason: defaultSecret.reason };
  const secretStatus: RouteTestStatus = !eligibility.eligible
    ? "BLOCKED"
    : evidence?.secretLivePassed === true
      ? "PASS"
      : "NOT_RUN";

  const cases: RouteTestCaseView[] = [
    { testKey: "SOURCE", label: "Source / Lane erreichbar", risk: "SAFE_LOCAL", status: state(evidence?.sourcePassed), detail: "Die konfigurierte Lane kann gelesen und eindeutig dieser Route zugeordnet werden." },
    { testKey: "SESSION", label: "Browser-Session gesund", risk: "SAFE_LOCAL", status: channel?.sessionHealth === "HEALTHY" && evidence?.sessionPassed ? "PASS" : channel?.sessionHealth && channel.sessionHealth !== "HEALTHY" ? "FAIL" : state(evidence?.sessionPassed), detail: channel ? `Session health: ${channel.sessionHealth}` : "Keine Session-Readiness vorhanden." },
    { testKey: "IDENTITY", label: "Account Identity", risk: "SAFE_LOCAL", status: channel?.identityVerified && evidence?.identityPassed ? "PASS" : channel?.identityVerified === false ? "FAIL" : state(evidence?.identityPassed), detail: account ? `Erwarteter Account ${accountLabel}.` : "Social account fehlt." },
    { testKey: "SURFACE", label: "Platform Surface Contract", risk: "SAFE_LOCAL", status: channel ? (surfacePass ? "PASS" : channel.surfaceContract === "DRIFTED" ? "FAIL" : "NOT_RUN") : "NOT_RUN", detail: channel ? `Surface: ${channel.surfaceContract}` : "Kein Surface-Status vorhanden." },
    { testKey: "PREPARE_ONLY", label: "Prepare-only 3×", risk: "PREPARE_ONLY", status: preparePasses >= 3 ? "PASS" : preparePasses > 0 ? "FAIL" : "NOT_RUN", detail: `${preparePasses}/3 erfolgreiche Replays; finaler Publish bleibt verboten.` },
    { testKey: "SECRET_LIVE", label: "Secret-live E2E", risk: "LIVE_SECRET", status: secretStatus, detail: eligibility.reason },
    { testKey: "VERIFICATION", label: "Post-Verifikation", risk: "PREPARE_ONLY", status: state(evidence?.verificationPassed), detail: "Receipt/Profile-Evidence muss den Publication-Status beweisen." },
    { testKey: "CLEANUP", label: "Testpost-Cleanup", risk: "LIVE_SECRET", status: secretStatus === "BLOCKED" ? "BLOCKED" : state(evidence?.cleanupPassed), detail: "Nur für explizit erlaubte Live-Testpublikationen; Cleanup muss erneut verifiziert werden." }
  ];

  const hardBlocked = !route.enabled || !platformCompatible || channel?.sessionHealth === "AUTH_REQUIRED" || channel?.sessionHealth === "CHALLENGE" || channel?.sessionHealth === "IDENTITY_MISMATCH" || channel?.surfaceContract === "DRIFTED";
  const requiredPass = cases.filter((item) => ["SOURCE", "SESSION", "IDENTITY", "SURFACE", "PREPARE_ONLY", "VERIFICATION"].includes(item.testKey));
  const overall = hardBlocked ? "BLOCKED" : requiredPass.every((item) => item.status === "PASS") ? "READY" : "NEEDS_TEST";
  return { routeId: route.routeId, routeName: route.displayName, account: accountLabel, platform: route.platform, postingProfile: profile?.displayName ?? "MISSING", overall, cases };
}
