import type { E2EGateResult, PrivateE2ERun } from "./e2e.js";
import type { PublicationIntent, PublishAttempt } from "./model.js";

export interface PrivateE2EIntentCandidate {intent:PublicationIntent;routeId:string;surfaceContractId?:string;state:string;}
export interface PrivateE2ERunView {run:PrivateE2ERun;gates:readonly E2EGateResult[];intent?:PublicationIntent;attempt?:PublishAttempt;routeId?:string;surfaceContractId?:string;}
export interface PrivateE2ECommandPort {
  candidates():readonly PrivateE2EIntentCandidate[];
  runs():readonly PrivateE2ERunView[];
  start(intentId:string,note:string|undefined,now:string):PrivateE2ERun;
  syncEvidence(runId:string,now:string):Promise<PrivateE2ERunView>;
  attestPrivacy(runId:string,input:{accountPrivate:boolean;approvedFollowers:number;contactsSyncOff:boolean;crossPostingOff:boolean;testMediaOnly:boolean},now:string):void;
  prepare(runId:string,now:string):Promise<PublishAttempt>;
  invokeFinal(runId:string,confirm:string,now:string):Promise<string>;
  verify(runId:string,now:string):Promise<string>;
  confirmCleanup(runId:string,confirm:string,note:string,now:string):void;
  cancelPrepared(runId:string,now:string):Promise<void>;
}
