import type { DistributionIntentProvenance } from "./distribution-provenance.js";
import type { PostingProfile } from "./distribution.js";
import type { PublicationIntent } from "./model.js";

export interface DistributionPostingContext {
  intent: PublicationIntent;
  provenance: DistributionIntentProvenance;
  postingProfile: PostingProfile;
}

export interface DistributionPostingContextResolverPort {
  resolve(intent: PublicationIntent): DistributionPostingContext;
}
