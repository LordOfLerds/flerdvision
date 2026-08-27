import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DistributionProvenanceStorePort } from "../domain/distribution-provenance-ports.js";
import type { DistributionIntentProvenance } from "../domain/distribution-provenance.js";
import type { PostingProfile } from "../domain/distribution.js";
import type { PublicationIntent } from "../domain/model.js";
import { routePlanningSnapshot } from "./distribution-plan-provenance.js";

export class DistributionIntentContextError extends Error {}
export interface ResolvedDistributionPostingContext { intent: PublicationIntent; provenance: DistributionIntentProvenance; postingProfile: PostingProfile; }

export class DistributionPostingContextResolver {
  constructor(private readonly provenance: DistributionProvenanceStorePort, private readonly config: DistributionConfigurationStorePort) {}
  resolve(intent: PublicationIntent): ResolvedDistributionPostingContext {
    const stored=this.provenance.getIntent(intent.intentId);
    if(!stored) throw new DistributionIntentContextError(`Intent ${intent.intentId} has no distribution provenance`);
    const envelope=stored.envelope;
    if(JSON.stringify(envelope.intent)!==JSON.stringify(intent)) throw new DistributionIntentContextError(`Intent ${intent.intentId} differs from the immutable distribution envelope`);
    const current=this.config.load();
    const route=current.config.routes.find((item)=>item.routeId===envelope.provenance.routeId);
    if(!route||!route.enabled) throw new DistributionIntentContextError(`Route ${envelope.provenance.routeId} is missing or disabled`);
    const currentSnapshot=routePlanningSnapshot(current,route);
    if(currentSnapshot.fingerprint!==envelope.provenance.routeSnapshotFingerprint) throw new DistributionIntentContextError(`Route ${route.routeId} changed after intent materialization; stale intent must not publish`);
    const postingProfile=envelope.provenance.postingProfileSnapshot;
    if(postingProfile.platform!==intent.platform||postingProfile.format!==intent.format) throw new DistributionIntentContextError(`Frozen posting profile does not match intent ${intent.intentId}`);
    return{intent,provenance:envelope.provenance,postingProfile};
  }
}
