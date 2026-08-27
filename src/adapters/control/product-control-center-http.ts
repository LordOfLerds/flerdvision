import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ControlCenterRuntimePort } from "../../domain/control-center-ports.js";
import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { OperatingCalendar, OperatingCalendarDateOverride, OperatingCalendarWeekdayRule } from "../../domain/operating-calendar.js";
import type { ExecutableRouteTestKey } from "../../domain/route-test-ports.js";
import type { RouteTestCommandPort } from "../../domain/route-test-command-ports.js";
import type { SourceActivationCommandPort } from "../../domain/source-activation-ports.js";
import type { SchedulingPolicy } from "../../domain/scheduling.js";
import { sourceActivationCursorFingerprint } from "../../application/source-activation.js";
import { PublishingProgramManagementService, type PublishingProgramDraft } from "../../application/publishing-program-management.js";
import { RhythmCalendarManagementService } from "../../application/rhythm-calendar-management.js";
import { DistributionConfigurationRevisionConflict } from "../distribution/json-config-store.js";
import { escapeProductHtml as esc, renderProductControlPage } from "./product-control-pages.js";

function parseBasic(header:string|string[]|undefined):{username:string;password:string}|null{
  if(typeof header!=="string"||!header.startsWith("Basic "))return null;
  try{const decoded=Buffer.from(header.slice(6),"base64").toString("utf8"),i=decoded.indexOf(":");return i<0?null:{username:decoded.slice(0,i),password:decoded.slice(i+1)};}catch{return null;}
}
async function form(req:IncomingMessage):Promise<URLSearchParams>{return await new Promise(resolve=>{let body="";req.on("data",chunk=>{body+=chunk.toString();});req.on("end",()=>resolve(new URLSearchParams(body)));});}
function required(params:URLSearchParams,key:string):string{const value=(params.get(key)??"").trim();if(!value)throw new Error(`${key} is required`);return value;}
function bool(params:URLSearchParams,key:string):boolean{return params.get(key)==="on"||params.get(key)==="true";}
function positiveInt(raw:string,label:string):number{const value=Number(raw);if(!Number.isInteger(value)||value<0)throw new Error(`${label} must be a non-negative integer`);return value;}
function executableRouteTestKey(value:string):ExecutableRouteTestKey{
  if(value==="SOURCE"||value==="SESSION"||value==="IDENTITY"||value==="SURFACE"||value==="PREPARE_ONLY"||value==="VERIFICATION"||value==="CLEANUP")return value;
  throw new Error(`Unsupported executable route test key: ${value}`);
}

interface SignedChange {kind:"PROGRAM"|"RHYTHM"|"CALENDAR";payload:unknown;revision:number;returnTo:string;}
interface SignedSourceBaselineAction {kind:"SOURCE_BASELINE_CAPTURE";laneId:string;snapshotFingerprint:string;cursorFingerprint:string;previewedAt:string;}

export interface ProductControlCenterHttpOptions {
  password:string;
  username?:string;
  host?:string;
  port?:number;
  now?:()=>string;
  businessDate?:()=>string;
  routeTests?:RouteTestCommandPort;
  sourceActivation?:SourceActivationCommandPort;
}

export class ProductControlCenterHttpServer {
  private server:Server|undefined;
  private readonly csrf=randomBytes(24).toString("hex");
  private readonly signingSecret=randomBytes(32).toString("hex");
  private readonly now:()=>string;
  private readonly businessDate:()=>string;

  constructor(private readonly config:DistributionConfigurationStorePort,private readonly runtime:ControlCenterRuntimePort,private readonly options:ProductControlCenterHttpOptions){
    if(!options.password)throw new Error("Control Center password is required");
    this.now=options.now??(()=>new Date().toISOString());
    this.businessDate=options.businessDate??(()=>new Date(this.now()).toISOString().slice(0,10));
  }

  private authorized(req:IncomingMessage):boolean{const auth=parseBasic(req.headers.authorization);return Boolean(auth&&auth.username===(this.options.username??"flerdvision")&&auth.password===this.options.password);}
  private deny(res:ServerResponse):void{res.statusCode=401;res.setHeader("WWW-Authenticate",'Basic realm="Flerdvision Control"');res.end("Authentication required");}
  private redirect(res:ServerResponse,location:string):void{res.statusCode=303;res.setHeader("Location",location);res.end();}
  private signature(payload:string):string{return createHash("sha256").update(`${this.signingSecret}|${payload}|${this.signingSecret}`).digest("hex");}
  private sign(change:SignedChange):{payload:string;signature:string}{const payload=Buffer.from(JSON.stringify(change),"utf8").toString("base64url");return{payload,signature:this.signature(payload)};}
  private verify(payload:string,signature:string):SignedChange{if(this.signature(payload)!==signature)throw new Error("Preview signature invalid");return JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as SignedChange;}
  private signBaseline(action:SignedSourceBaselineAction):{payload:string;signature:string}{const payload=Buffer.from(JSON.stringify(action),"utf8").toString("base64url");return{payload,signature:this.signature(payload)};}
  private verifyBaseline(payload:string,signature:string):SignedSourceBaselineAction{
    if(this.signature(payload)!==signature)throw new Error("Source baseline preview signature invalid");
    const action=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as SignedSourceBaselineAction;
    if(action.kind!=="SOURCE_BASELINE_CAPTURE"||!action.laneId||!action.snapshotFingerprint||!action.cursorFingerprint)throw new Error("Invalid source baseline confirmation payload");
    return action;
  }
  private impactPage(change:SignedChange,title:string,summary:string,details:string):string{
    const signed=this.sign(change);
    return `<!doctype html><html lang=de><meta charset=utf-8><title>${esc(title)}</title><body style="font-family:system-ui;max-width:900px;margin:40px auto"><h1>${esc(title)}</h1><div style="border-left:4px solid #0e6b64;padding:12px 16px;background:#f1f8f6"><p>${esc(summary)}</p>${details}</div><form method=post action=/apply><input type=hidden name=csrf value=${this.csrf}><input type=hidden name=payload value="${esc(signed.payload)}"><input type=hidden name=signature value="${esc(signed.signature)}"><button>Änderung bestätigen</button> <a href="${esc(change.returnTo)}">Abbrechen</a></form></body></html>`;
  }

  private programDraft(params:URLSearchParams):PublishingProgramDraft{
    const laneId=required(params,"laneId"),businessDate=(params.get("businessDate")??"").trim()||undefined;
    const accounts=params.getAll("accountId"),profiles=params.getAll("postingProfileId"),copies=params.getAll("copyProfileId"),schedules=params.getAll("schedulePolicyId"),calendars=params.getAll("operatingCalendarId"),requirements=params.getAll("requirement");
    if(accounts.length===0)throw new Error("At least one target is required");
    const targets=accounts.map((accountId,index)=>({accountId,postingProfileId:profiles[index]??"",copyProfileId:copies[index]??"",schedulePolicyId:schedules[index]??"",...(calendars[index]?{operatingCalendarId:calendars[index]}:{}),requirement:requirements[index]==="OPTIONAL"?"OPTIONAL" as const:"REQUIRED" as const,enabled:true}));
    return{laneId,...(businessDate?{businessDate}:{}),targets};
  }
  private rhythmFrom(params:URLSearchParams):{id:string;policy:SchedulingPolicy}{
    const id=required(params,"schedulePolicyId");
    const slots=required(params,"slots").split(",").map(part=>part.trim()).filter(Boolean).map((part,index)=>{const [key,time]=part.includes("@")?part.split("@",2):[`slot-${index+1}`,part];if(!key||!time)throw new Error(`Invalid slot: ${part}`);return{key:key.trim(),localTime:time.trim()};});
    return{id,policy:{timeZone:required(params,"timeZone"),slots,windowMinutes:positiveInt(required(params,"windowMinutes"),"windowMinutes"),maxPerAccountPerBusinessDate:positiveInt(required(params,"maxPerDay"),"maxPerDay"),minimumSpacingMinutes:positiveInt(required(params,"minimumSpacingMinutes"),"minimumSpacingMinutes"),overflowAllowed:false,overflowMinimumSpacingMinutes:240}};
  }
  private calendarFrom(params:URLSearchParams):OperatingCalendar{
    const weekdayRules:OperatingCalendarWeekdayRule[]=[];
    for(const line of (params.get("weekdays")??"").split("\n").map(value=>value.trim()).filter(Boolean)){
      const [day,rawActive,schedule]=line.split("|").map(value=>value.trim()),number=Number(day);if(!Number.isInteger(number)||number<1||number>7)throw new Error(`Invalid ISO weekday: ${day}`);
      weekdayRules.push({isoWeekday:number as 1|2|3|4|5|6|7,active:rawActive!=="off",...(schedule?{schedulePolicyId:schedule}:{})});
    }
    const dateOverrides:OperatingCalendarDateOverride[]=[];
    for(const line of (params.get("dates")??"").split("\n").map(value=>value.trim()).filter(Boolean)){
      const [businessDate,rawActive,schedule,note]=line.split("|").map(value=>value.trim());if(!businessDate)throw new Error("Date override requires businessDate");
      dateOverrides.push({businessDate,active:rawActive!=="off",...(schedule?{schedulePolicyId:schedule}:{}),...(note?{note}:{})});
    }
    return{calendarId:required(params,"calendarId"),displayName:required(params,"displayName"),enabled:bool(params,"enabled"),weekdayRules,dateOverrides};
  }

  private async preview(path:string,params:URLSearchParams):Promise<string>{
    if(path==="/preview/program"){
      const snapshot=await this.runtime.snapshot(this.businessDate()),draft=this.programDraft(params),preview=new PublishingProgramManagementService(this.config,()=>snapshot.accounts).preview(draft);
      const change:SignedChange={kind:"PROGRAM",payload:draft,revision:preview.currentRevision,returnTo:"/programs"};
      const rhythms=preview.rhythms.map(item=>`<li><code>${esc(item.routeId)}</code> · ${item.active?item.slots.map(esc).join(" / "):"aus"} · ${esc(item.source)}</li>`).join("");
      return this.impactPage(change,"Program-Auswirkungen",`${preview.affectedRouteIds.length} Route(s), ${preview.requiredAssetCountPerBusinessDate} Quellvideo(s) für den Preview-Tag.`,`<ul>${rhythms}</ul><p>Bestehende committed und verified Historie bleibt unverändert. Neue/änderte Routes müssen Qualifikation bestehen.</p>`);
    }
    const service=new RhythmCalendarManagementService(this.config);
    if(path==="/preview/rhythm"){
      const {id,policy}=this.rhythmFrom(params),preview=service.previewSchedulePolicy(id,policy),change:SignedChange={kind:"RHYTHM",payload:{id,policy},revision:preview.currentRevision,returnTo:"/rhythms"};
      return this.impactPage(change,"Rhythm-Auswirkungen",preview.operatorSummary,`<p>Betroffene Routes: ${preview.affectedRouteIds.map(id=>`<code>${esc(id)}</code>`).join(" ")||"keine"}</p>`);
    }
    if(path==="/preview/calendar"){
      const calendar=this.calendarFrom(params),preview=service.previewOperatingCalendar(calendar),change:SignedChange={kind:"CALENDAR",payload:calendar,revision:preview.currentRevision,returnTo:"/rhythms"};
      return this.impactPage(change,"Kalender-Auswirkungen",preview.operatorSummary,`<p>Betroffene Routes: ${preview.affectedRouteIds.map(id=>`<code>${esc(id)}</code>`).join(" ")||"keine"}</p>`);
    }
    throw new Error("Unknown preview action");
  }
  private async apply(change:SignedChange):Promise<string>{
    if(change.kind==="PROGRAM"){
      const snapshot=await this.runtime.snapshot(this.businessDate());new PublishingProgramManagementService(this.config,()=>snapshot.accounts).apply(change.payload as PublishingProgramDraft,change.revision,this.now());return change.returnTo;
    }
    const service=new RhythmCalendarManagementService(this.config);
    if(change.kind==="RHYTHM"){const payload=change.payload as {id:string;policy:SchedulingPolicy};service.saveSchedulePolicy(payload.id,payload.policy,change.revision,this.now());}
    else service.saveOperatingCalendar(change.payload as OperatingCalendar,change.revision,this.now());
    return change.returnTo;
  }

  private async sourceBaselinePreview(params:URLSearchParams):Promise<string>{
    if(!this.options.sourceActivation)throw new Error("Source activation command adapter is not configured on this host");
    const laneId=required(params,"laneId"),preview=await this.options.sourceActivation.previewBaseline(laneId,this.now());
    const signed=this.signBaseline({kind:"SOURCE_BASELINE_CAPTURE",laneId:preview.laneId,snapshotFingerprint:preview.snapshotFingerprint,cursorFingerprint:preview.cursorFingerprint,previewedAt:preview.previewedAt});
    const samples=preview.sampleFileNames.length?`<ul>${preview.sampleFileNames.map(name=>`<li>${esc(name)}</li>`).join("")}</ul>`:"<p>Keine bestehenden Medienobjekte in dieser Lane.</p>";
    return `<!doctype html><html lang=de><meta charset=utf-8><title>Baseline prüfen</title><body style="font-family:system-ui;max-width:900px;margin:40px auto"><h1>NEW_ONLY Baseline prüfen</h1><div style="border-left:4px solid #0e6b64;padding:12px 16px;background:#f1f8f6"><p><strong>${preview.observedCount}</strong> bestehende Datei(en) werden als historisch markiert und nicht als neue Posting-Arbeit behandelt.</p>${samples}<p><small>Snapshot ${esc(preview.snapshotFingerprint.slice(0,16))} · Cursor ${esc(preview.cursorFingerprint.slice(0,16))}</small></p><p>Ändert sich der Ordner vor Confirm, wird die Aktion verweigert und muss neu geprüft werden.</p></div><form method=post action=/sources/baseline-capture><input type=hidden name=csrf value=${this.csrf}><input type=hidden name=payload value="${esc(signed.payload)}"><input type=hidden name=signature value="${esc(signed.signature)}"><button>Genau diese Baseline erfassen</button> <a href=/sources>Abbrechen</a></form></body></html>`;
  }
  private sourceActivationControls(stored:ReturnType<DistributionConfigurationStorePort["load"]>,runtime:Awaited<ReturnType<ControlCenterRuntimePort["snapshot"]>>):string{
    if(!this.options.sourceActivation)return"";
    const statusMap=new Map((runtime.sourceActivation??[]).map(item=>[item.laneId,item]));
    const rows=stored.config.lanes.map(lane=>{
      const status=statusMap.get(lane.laneId);
      if(status?.state==="MISSING_BASELINE")return`<tr><td>${esc(lane.displayName)}</td><td class=bad>MISSING_BASELINE</td><td><form method=post action=/sources/baseline-preview><input type=hidden name=csrf value=${this.csrf}><input type=hidden name=laneId value="${esc(lane.laneId)}"><button>Bestehende Dateien prüfen</button></form></td></tr>`;
      if(status?.state==="CAPTURED")return`<tr><td>${esc(lane.displayName)}</td><td class=ok>CAPTURED</td><td>${status.baselineCount??0} bestehende Datei(en) · ${status.capturedAt?esc(new Date(status.capturedAt).toLocaleString("de-AT",{timeZone:"Europe/Vienna"})):""}</td></tr>`;
      return`<tr><td>${esc(lane.displayName)}</td><td>${esc(status?.state??"NOT_EVALUATED")}</td><td>${status?.reason?esc(status.reason):"—"}</td></tr>`;
    }).join("");
    return`<div class=card><h2>Activation Actions</h2><p class=muted>NEW_ONLY wird erst aktiv, nachdem die vorhandenen Dateien per Preview → Confirm als Baseline erfasst wurden.</p><table><tr><th>Lane</th><th>Status</th><th>Aktion</th></tr>${rows||"<tr><td colspan=3>Keine Lanes.</td></tr>"}</table></div>`;
  }

  private async page(path:string):Promise<string>{
    const businessDate=this.businessDate(),stored=this.config.load(),runtime=await this.runtime.snapshot(businessDate);
    let html=renderProductControlPage({path,stored,runtime,businessDate,csrf:this.csrf,...(this.options.routeTests?{routeTests:this.options.routeTests}:{})});
    if(path==="/sources")html=html.replace("</main>",`${this.sourceActivationControls(stored,runtime)}</main>`);
    return html;
  }

  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    if(!this.authorized(req)){this.deny(res);return;}
    const method=req.method??"GET",url=new URL(req.url??"/","http://127.0.0.1"),path=url.pathname;
    try{
      if(method==="GET"){
        if(path==="/"){this.redirect(res,"/today");return;}
        const allowed=new Set(["/today","/programs","/content","/sources","/channels","/profiles","/rhythms","/test-lab","/incidents","/activity"]);
        if(!allowed.has(path)){res.statusCode=404;res.end("Not found");return;}
        const html=await this.page(path);res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;
      }
      if(method!=="POST"){res.statusCode=404;res.end("Not found");return;}
      const params=await form(req);if(params.get("csrf")!==this.csrf){res.statusCode=403;res.end("Invalid CSRF token");return;}
      if(path.startsWith("/preview/")){const html=await this.preview(path,params);res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;}
      if(path==="/apply"){const destination=await this.apply(this.verify(required(params,"payload"),required(params,"signature")));this.redirect(res,destination);return;}
      if(path==="/sources/baseline-preview"){const html=await this.sourceBaselinePreview(params);res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;}
      if(path==="/sources/baseline-capture"){
        if(!this.options.sourceActivation)throw new Error("Source activation command adapter is not configured on this host");
        const action=this.verifyBaseline(required(params,"payload"),required(params,"signature"));
        const current=this.config.load().config.activationCursors.find(item=>item.laneId===action.laneId);if(!current)throw new Error(`Lane ${action.laneId} no longer has an activation cursor`);
        if(sourceActivationCursorFingerprint(current)!==action.cursorFingerprint)throw new Error(`Lane ${action.laneId} activation cursor changed after preview; preview again before capture`);
        await this.options.sourceActivation.captureBaseline(action.laneId,this.now(),action.snapshotFingerprint);this.redirect(res,"/sources");return;
      }
      if(path==="/test-lab/run"){
        if(!this.options.routeTests)throw new Error("Route test command adapter is not configured on this host/release");
        const routeId=required(params,"routeId"),testKey=executableRouteTestKey(required(params,"testKey"));await this.options.routeTests.run(routeId,testKey,this.now());this.redirect(res,"/test-lab");return;
      }
      res.statusCode=404;res.end("Not found");
    }catch(error){res.statusCode=error instanceof DistributionConfigurationRevisionConflict?409:400;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end(error instanceof Error?error.message:String(error));}
  }

  async start():Promise<{host:string;port:number}>{
    if(this.server)throw new Error("Control Center already started");
    const host=this.options.host??"127.0.0.1",port=this.options.port??0;this.server=createServer((req,res)=>{void this.handle(req,res);});
    await new Promise<void>(resolve=>this.server!.listen(port,host,resolve));const address=this.server.address();if(!address||typeof address==="string")throw new Error("Control Center did not expose TCP address");return{host,port:address.port};
  }
  async stop():Promise<void>{if(!this.server)return;const server=this.server;this.server=undefined;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
