import type { SourceLane } from "../../domain/distribution.js";
import type { SourceObservation } from "../../domain/model.js";
import type { IngressInterpretation, IngressInterpreterPort } from "../../domain/ports.js";
import type { SourceLaneInterpreterFactoryPort } from "../../domain/source-lane-runtime.js";
import { CurrentCreatorWeekDayPathInterpreter, MetadataFieldIngressInterpreter } from "./interpreters.js";

export interface SourceLaneInterpreterFactoryConfig {
  /** Temporary migration/test overrides; canonical values live on SourceLane. */
  creatorIdByLaneId?: Readonly<Record<string, string>>;
  creatorAliases?: Readonly<Record<string, string>>;
  weekStartBySegment?: Readonly<Record<string, string>>;
  formatFolderHints?: Readonly<Record<string, readonly string[]>>;
}

class LaneOwnerOverlayInterpreter implements IngressInterpreterPort {
  constructor(private readonly inner: IngressInterpreterPort, private readonly creatorId?: string) {}
  async interpret(observation: SourceObservation): Promise<IngressInterpretation> {
    if (!this.creatorId) return this.inner.interpret(observation);
    return this.inner.interpret({ ...observation, metadata: { creatorId: this.creatorId, ...observation.metadata } });
  }
}

export class ConfiguredSourceLaneInterpreterFactory implements SourceLaneInterpreterFactoryPort {
  constructor(private readonly config: SourceLaneInterpreterFactoryConfig = {}) {}

  forLane(lane: SourceLane): IngressInterpreterPort {
    const explicitCreatorId = lane.creatorId ?? this.config.creatorIdByLaneId?.[lane.laneId];
    if (lane.interpretation.kind === "metadata") {
      return new LaneOwnerOverlayInterpreter(new MetadataFieldIngressInterpreter({
        ...(lane.interpretation.creatorField ? { creatorField: lane.interpretation.creatorField } : {}),
        ...(lane.interpretation.businessDateField ? { businessDateField: lane.interpretation.businessDateField } : {})
      }), explicitCreatorId);
    }
    if (lane.interpretation.kind === "creator_week_day") {
      const aliases: Record<string, string> = { ...(this.config.creatorAliases ?? {}) };
      const scopedAlias=lane.interpretation.creatorAlias??(explicitCreatorId?lane.laneId:undefined);
      if (scopedAlias && explicitCreatorId) aliases[scopedAlias] = explicitCreatorId;
      return new CurrentCreatorWeekDayPathInterpreter({
        creatorAliases: aliases,
        ...((lane.interpretation.weekStartBySegment??this.config.weekStartBySegment) ? { weekStartBySegment: lane.interpretation.weekStartBySegment??this.config.weekStartBySegment } : {}),
        ...((lane.interpretation.formatFolderHints??this.config.formatFolderHints) ? { formatFolderHints: lane.interpretation.formatFolderHints??this.config.formatFolderHints } : {})
      });
    }
    // Flat lanes intentionally require SourceLane.creatorId or source metadata. They never infer
    // creator identity from displayName/folderPath.
    return new LaneOwnerOverlayInterpreter(new MetadataFieldIngressInterpreter(), explicitCreatorId);
  }
}
