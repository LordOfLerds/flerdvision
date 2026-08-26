import type { SourceObservation } from "../../domain/model.js";
import type { ContentIngressPort } from "../../domain/ports.js";

export class FixtureIngressAdapter implements ContentIngressPort {
  constructor(private readonly observations: readonly SourceObservation[]) {}

  async observe(): Promise<readonly SourceObservation[]> {
    return this.observations.map((observation) => ({ ...observation, metadata: { ...observation.metadata } }));
  }
}
