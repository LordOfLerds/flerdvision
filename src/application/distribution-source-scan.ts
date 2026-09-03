import { createHash } from "node:crypto";
import type { Actor } from "../domain/control-plane.js";
import type { DistributionConfigurationStorePort } from "../domain/distribution-ports.js";
import type { DistributionRuntimeStateStorePort } from "../domain/distribution-runtime-ports.js";
import type { ContentAsset, SourceActivationCursor, SourceConnection, SourceLane } from "../domain/distribution.js";
import type { IngressRunReport } from "../domain/ingress.js";
import type { IngressStorePort } from "../domain/ingress-ports.js";
import type { ContentItem, SourceObservation } from "../domain/model.js";
import type { ContentIngressPort, SourceDispositionPort } from "../domain/ports.js";
import type {
  MediaReadinessProbePort,
  SourceActivationBaselineStorePort,
  SourceLaneInterpreterFactoryPort,
  SourceLaneObservationPort,
  SourceLaneScanLaneReport,
  SourceLaneScanReport
} from "../domain/source-lane-runtime.js";
import type { NotificationOutboxPort } from "../domain/operations-ports.js";
import type { NotificationMessage } from "../domain/operations.js";
import { ContentIngressService } from "./ingress-service.js";
import { activationDecision, sourceActivationCursorFingerprint } from "./source-activation.js";
import { filenameParts } from "../adapters/publish/workspace-payload-resolver.js";
import { germanBlockReason, renderOperatorMessage } from "./operator-message.js";

function sha(value:string):string{return createHash("sha256").update(value).digest("hex").slice(0,32);}
class FixedObservationSource implements ContentIngressPort {
  constructor(private readonly items:readonly SourceObservation[]){}
  async observe():Promise<readonly SourceObservation[]>{return this.items;}
}
function sourceForLane(config:ReturnType<DistributionConfigurationStorePort["load"]>,lane:SourceLane):SourceConnection|undefined{
  return config.config.sources.find((source)=>source.connectionId===lane.connectionId);
}
function cursorForLane(config:ReturnType<DistributionConfigurationStorePort["load"]>,lane:SourceLane):SourceActivationCursor|undefined{
  return config.config.activationCursors.find((cursor)=>cursor.laneId===lane.laneId);
}
function assetFor(content:ContentItem,lane:SourceLane,observation:SourceObservation,state:ContentAsset["state"],metadata:Record<string,string>):ContentAsset{
  const asset:ContentAsset={
    assetId:`asset:${sha(`${lane.laneId}|${content.contentId}`)}`,
    contentId:content.contentId,
    laneId:lane.laneId,
    creatorId:content.creatorId,
    sourceObservationId:observation.observationId,
    sourceRef:content.immutableMediaRef,
    externalObjectId:observation.externalObjectId,
    filename:content.metadata.fileName??observation.metadata.fileName??observation.externalObjectId,
    mediaFingerprint:content.mediaFingerprint,
    observedAt:observation.observedAt,
    state,
    metadata:{...content.metadata,...metadata}
  };
  if(content.scheduledBusinessDate)Object.assign(asset,{scheduledBusinessDate:content.scheduledBusinessDate});
  return asset;
}
function sizeOf(observation:SourceObservation):string|undefined{return observation.metadata.size;}

export interface DistributionSourceScanOptions {
  notifyBlocksExternally?: boolean;
  /** Durable outbox for the "this file is unusable" message; omitted means no operator message. */
  outbox?: NotificationOutboxPort;
  notificationChannelKeys?: readonly string[];
}

export class DistributionSourceScanCoordinator {
  constructor(
    private readonly configStore:DistributionConfigurationStorePort,
    private readonly observations:SourceLaneObservationPort,
    private readonly interpreters:SourceLaneInterpreterFactoryPort,
    private readonly ingressStore:IngressStorePort,
    private readonly disposition:SourceDispositionPort,
    private readonly baselines:SourceActivationBaselineStorePort,
    private readonly runtime:DistributionRuntimeStateStorePort,
    private readonly readiness:MediaReadinessProbePort,
    private readonly options:DistributionSourceScanOptions={}
  ){}

  async run(now:string,actor:Actor={type:"system",id:"distribution-source-scan"}):Promise<SourceLaneScanReport>{
    const startedAt=new Date(now).toISOString();
    const stored=this.configStore.load();
    const laneReports:SourceLaneScanLaneReport[]=[];

    for(const lane of stored.config.lanes.filter((item)=>item.enabled)){
      const source=sourceForLane(stored,lane);
      if(!source||!source.enabled){laneReports.push(this.blockedLane(lane,"source_missing_or_disabled"));continue;}
      const cursor=cursorForLane(stored,lane);
      if(!cursor){laneReports.push(this.blockedLane(lane,"activation_cursor_missing"));continue;}
      const baseline=cursor.mode==="NEW_ONLY"
        ? this.baselines.getBaseline(lane.laneId,sourceActivationCursorFingerprint(cursor))?.baseline??null
        : null;
      if(cursor.mode==="NEW_ONLY"&&!baseline){laneReports.push(this.blockedLane(lane,"new_only_activation_baseline_missing"));continue;}

      let observed:readonly SourceObservation[];
      try{observed=await this.observations.observeLane(source,lane,startedAt);}
      catch(error){laneReports.push(this.blockedLane(lane,`observe_failed:${error instanceof Error?error.message:String(error)}`));continue;}

      const eligible:SourceObservation[]=[];
      let historicalIgnored=0;
      let activationBlocked=0;
      for(const observation of observed){
        const decision=activationDecision(cursor,baseline,observation);
        if(decision.eligible)eligible.push(observation);
        else if(decision.reason==="MISSING_TIMESTAMP")activationBlocked+=1;
        else historicalIgnored+=1;
      }

      let ingressReport:IngressRunReport;
      try{
        ingressReport=await new ContentIngressService(
          new FixedObservationSource(eligible),
          this.interpreters.forLane(lane),
          this.ingressStore,
          this.disposition,
          {notifyBlocksExternally:this.options.notifyBlocksExternally??false}
        ).run(startedAt,actor);
      }catch(error){laneReports.push({laneId:lane.laneId,observed:observed.length,eligible:eligible.length,historicalIgnored,accepted:0,stabilizing:0,ready:0,blocked:eligible.length+activationBlocked,conflicts:0,notes:[`ingress_failed:${error instanceof Error?error.message:String(error)}`]});continue;}

      let stabilizing=0,ready=0,blocked=activationBlocked,conflicts=ingressReport.conflicts;
      const notes:string[]=[];
      for(const observation of eligible){
        const sourceRecord=this.ingressStore.getSourceObservation(observation.observationId);
        if(!sourceRecord){blocked+=1;notes.push(`${observation.externalObjectId}:source_record_missing`);continue;}
        const originalFingerprint=sourceRecord.observation.mediaFingerprint;
        if(originalFingerprint!==observation.mediaFingerprint){
          const existing=[...this.runtime.listAssets()].find((record)=>record.asset.sourceObservationId===observation.observationId)?.asset;
          if(existing&&existing.state!=="BLOCKED"&&existing.state!=="COMPLETE"){
            this.runtime.putAsset({...existing,state:"BLOCKED",metadata:{...existing.metadata,blockReason:"source_media_mutated"}},startedAt);
            this.announceBlocked(existing,"source_media_mutated",startedAt,actor);
          }
          blocked+=1;continue;
        }
        if(sourceRecord.state==="BLOCKED"){blocked+=1;continue;}
        if(sourceRecord.state!=="ACCEPTED"||!sourceRecord.contentId)continue;
        const contentRecord=this.ingressStore.getContentItem(sourceRecord.contentId);
        if(!contentRecord){blocked+=1;notes.push(`${observation.externalObjectId}:content_missing`);continue;}
        const content=contentRecord.item;
        const assetId=`asset:${sha(`${lane.laneId}|${content.contentId}`)}`;
        const existing=this.runtime.getAsset(assetId)?.asset;
        if(existing?.state==="COMPLETE"||existing?.state==="BLOCKED")continue;
        if(existing?.state==="READY"){ready+=1;continue;}

        const observedSize=sizeOf(observation);
        const stableFingerprint=sourceRecord.seenCount>=2;
        const stableSize=Boolean(observedSize&&existing&&existing.metadata.sourceSize===observedSize);
        if(!existing){
          this.runtime.putAsset(assetFor(content,lane,observation,"STABILIZING",{sourceSize:observedSize??"",stableObservations:String(sourceRecord.seenCount),lastSeenAt:startedAt}),startedAt);
          stabilizing+=1;continue;
        }
        if(!stableFingerprint||!stableSize){
          this.runtime.putAsset({...existing,state:"STABILIZING",metadata:{...existing.metadata,sourceSize:observedSize??"",stableObservations:String(sourceRecord.seenCount),lastSeenAt:startedAt}},startedAt);
          stabilizing+=1;continue;
        }

        const probe=await this.readiness.probe(content);
        if(probe.outcome==="READABLE"){
          this.runtime.putAsset({...existing,state:"READY",readyAt:startedAt,metadata:{...existing.metadata,stableObservations:String(sourceRecord.seenCount),lastSeenAt:startedAt,readinessSha256:probe.sha256??"",readinessSizeBytes:String(probe.sizeBytes??""),readinessDurationSeconds:String(probe.durationSeconds??""),readinessCheckedAt:startedAt}},startedAt);
          ready+=1;
        }else if(probe.outcome==="BLOCKED"){
          const blockReason=probe.note??"media_probe_blocked";
          this.runtime.putAsset({...existing,state:"BLOCKED",metadata:{...existing.metadata,blockReason,readinessCheckedAt:startedAt}},startedAt);
          this.announceBlocked(existing,blockReason,startedAt,actor);
          blocked+=1;
        }else{
          this.runtime.putAsset({...existing,state:"STABILIZING",metadata:{...existing.metadata,readinessRetryReason:probe.note??"media_probe_retry",readinessCheckedAt:startedAt}},startedAt);
          stabilizing+=1;
        }
      }

      laneReports.push({laneId:lane.laneId,observed:observed.length,eligible:eligible.length,historicalIgnored,accepted:ingressReport.accepted,stabilizing,ready,blocked,conflicts,notes});
    }

    return{
      startedAt,
      finishedAt:new Date().toISOString(),
      lanes:laneReports,
      observed:laneReports.reduce((sum,item)=>sum+item.observed,0),
      eligible:laneReports.reduce((sum,item)=>sum+item.eligible,0),
      ready:laneReports.reduce((sum,item)=>sum+item.ready,0),
      stabilizing:laneReports.reduce((sum,item)=>sum+item.stabilizing,0),
      blocked:laneReports.reduce((sum,item)=>sum+item.blocked,0),
      conflicts:laneReports.reduce((sum,item)=>sum+item.conflicts,0)
    };
  }

  /**
   * A file that cannot be used is the operator's problem, not the pipeline's: nobody watches a
   * counter, so the moment an ingress asset turns BLOCKED one message names the file and says
   * what to do about it. Deduped per asset revision, so re-scanning the same broken file stays
   * quiet while a replaced file (new media fingerprint) is announced again. Nothing is
   * transcoded or repaired automatically.
   */
  private announceBlocked(asset:ContentAsset,blockReason:string,at:string,actor:Actor):void{
    const outbox=this.options.outbox,channelKeys=this.options.notificationChannelKeys??[];
    if(!outbox||channelKeys.length===0)return;
    try{
      const reason=germanBlockReason(blockReason);
      const rendered=renderOperatorMessage("ATTENTION",{
        badge:"⚠️",
        headline:"Datei blockiert",
        videoLabel:filenameParts(asset.filename).text||asset.filename,
        ...(reason?{reason}:{}),
        nextStep:"Datei in Drive ersetzen — der Slot bleibt frei."
      });
      const revision=asset.mediaFingerprint??asset.observedAt;
      const message:NotificationMessage={
        notificationId:`notification:${sha(`asset-blocked|${asset.assetId}|${revision}`)}`,
        dedupeKey:`asset-blocked:${asset.assetId}:${revision}`,
        kind:"SYSTEM",
        severity:"WARNING",
        createdAt:new Date(at).toISOString(),
        subject:rendered.subject,
        body:rendered.body,
        metadata:{blockReason}
      };
      outbox.enqueueNotification(message,channelKeys,actor);
    }catch{
      // Reporting a blocked file must never break the scan that found it.
    }
  }

  private blockedLane(lane:SourceLane,note:string):SourceLaneScanLaneReport{
    return{laneId:lane.laneId,observed:0,eligible:0,historicalIgnored:0,accepted:0,stabilizing:0,ready:0,blocked:1,conflicts:0,notes:[note]};
  }
}
