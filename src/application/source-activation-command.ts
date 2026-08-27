import type { StoredDistributionConfiguration, DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { SourceActivationCommandPort, SourceActivationStatus } from "../domain/source-activation-ports.js";
import type { SourceActivationBaselineStorePort, SourceLaneObservationPort } from "../domain/source-lane-runtime.js";
import { SourceActivationService, sourceActivationCursorFingerprint } from "./source-activation.js";

export function sourceActivationStatus(
  stored:StoredDistributionConfiguration,
  baselines:SourceActivationBaselineStorePort,
  laneId:string
):SourceActivationStatus{
  const lane=stored.config.lanes.find((item)=>item.laneId===laneId);
  if(!lane)return{laneId,state:"MISCONFIGURED",reason:"lane_not_found"};
  const source=stored.config.sources.find((item)=>item.connectionId===lane.connectionId);
  if(!source)return{laneId,state:"MISCONFIGURED",reason:"source_not_found"};
  const cursor=stored.config.activationCursors.find((item)=>item.laneId===laneId);
  if(!cursor)return{laneId,state:"MISCONFIGURED",reason:"activation_cursor_missing"};
  if(cursor.mode!=="NEW_ONLY")return{laneId,mode:cursor.mode,state:"NOT_REQUIRED"};
  const baseline=baselines.getBaseline(laneId,sourceActivationCursorFingerprint(cursor));
  if(!baseline)return{laneId,mode:cursor.mode,state:"MISSING_BASELINE"};
  return{laneId,mode:cursor.mode,state:"CAPTURED",baselineCount:baseline.baseline.externalObjectIds.length,capturedAt:baseline.baseline.capturedAt};
}

export class SourceActivationCommandService implements SourceActivationCommandPort {
  private readonly activation:SourceActivationService;
  constructor(
    private readonly config:DistributionConfigurationStorePort,
    observations:SourceLaneObservationPort,
    private readonly baselines:SourceActivationBaselineStorePort
  ){
    this.activation=new SourceActivationService(observations,baselines);
  }

  status(laneId:string):SourceActivationStatus{
    return sourceActivationStatus(this.config.load(),this.baselines,laneId);
  }

  async captureBaseline(laneId:string,now:string):Promise<SourceActivationStatus>{
    const stored=this.config.load();
    const lane=stored.config.lanes.find((item)=>item.laneId===laneId);
    if(!lane)throw new Error(`Unknown lane: ${laneId}`);
    const source=stored.config.sources.find((item)=>item.connectionId===lane.connectionId);
    if(!source)throw new Error(`Lane ${laneId} references unknown source ${lane.connectionId}`);
    const cursor=stored.config.activationCursors.find((item)=>item.laneId===laneId);
    if(!cursor)throw new Error(`Lane ${laneId} has no activation cursor`);
    if(cursor.mode!=="NEW_ONLY")throw new Error(`Lane ${laneId} uses ${cursor.mode}; only NEW_ONLY has a capture baseline`);
    await this.activation.ensureBaseline(source,lane,cursor,now);
    return this.status(laneId);
  }
}
