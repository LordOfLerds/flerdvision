import type { PublicationIntent } from "./model.js";
import type {
  CopyProfile,
  DistributionPlanningPolicy,
  DistributionRoute,
  PostingProfile,
  SourceActivationCursor,
  SourceConnection,
  SourceLane
} from "./distribution.js";
import type { SchedulingPolicy } from "./scheduling.js";

export interface RoutePlanningSnapshot {
  routeId: string;
  source: SourceConnection;
  lane: SourceLane;
  activationCursor?: SourceActivationCursor;
  route: DistributionRoute;
  postingProfile: PostingProfile;
  copyProfile: CopyProfile;
  schedulePolicy: SchedulingPolicy;
  planningPolicy: DistributionPlanningPolicy;
  fingerprint: string;
}

export interface DailyPlanProvenance {
  planId: string;
  businessDate: string;
  capturedAt: string;
  routeSnapshots: Readonly<Record<string, RoutePlanningSnapshot>>;
}

export interface DistributionIntentProvenance {
  planId: string;
  deliveryId: string;
  routeId: string;
  laneId: string;
  assetId: string;
  postingProfileId: string;
  copyProfileId: string;
  schedulePolicyId: string;
  routeSnapshotFingerprint: string;
  postingProfileSnapshot: PostingProfile;
}

export interface DistributionPublicationIntentEnvelope {
  intent: PublicationIntent;
  provenance: DistributionIntentProvenance;
}

export interface StoredDailyPlanProvenance {
  provenance: DailyPlanProvenance;
  createdAt: string;
}

export interface StoredDistributionIntentEnvelope {
  envelope: DistributionPublicationIntentEnvelope;
  createdAt: string;
}
