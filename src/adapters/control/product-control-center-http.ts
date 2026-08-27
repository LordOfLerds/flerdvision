import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ControlCenterRuntimePort } from "../../domain/control-center-ports.js";
import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { OperatingCalendar, OperatingCalendarDateOverride, OperatingCalendarWeekdayRule } from "../../domain/operating-calendar.js";
import type { SchedulingPolicy } from "../../domain/scheduling.js";
import { projectPublishingPrograms } from "../../application/publishing-program-read-model.js";
import { PublishingProgramManagementService, type PublishingProgramDraft } from "../../application/publishing-program-management.js";
import { RhythmCalendarManagementService } from "../../application/rhythm-calendar-management.js";
import { projectContentQueue } from "../../application/control-center-content.js";
import { projectControlCenter } from "../../application/control-center-read-model.js";
import { incidentView } from "../../application/control-center-operator-surfaces.js";
import { projectActivity } from "../../application/control-center-activity.js";
import { DEFAULT_DISTRIBUTION_RUNTIME_POLICY } from "../../domain/distribution-operations.js";
import { DistributionConfigurationRevisionConflict } from "../distribution/json-config-store.js";

function esc(value:string):string{return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function parseBasic(header:string|string[]|undefined):{username:string;password:string}|null{
  if(typeof header!=="string"||!header.startsWith("Basic "))return null;
  try{const decoded=Buffer.from(header.slice(6),"base64").toString("utf8"),i=decoded.indexOf(":");return i<0?null:{username:decoded.slice(0,i),password:decoded.slice(i+1)};}catch{return null;}
}
async function form(req:IncomingMessage):Promise<URLSearchParams>{return await new Promise(resolve=>{let body="";req.on("data",chunk=>{body+=chunk.toString();});req.on("end",()=>resolve(new URLSearchParams(body)));});}
function required(params:URLSearchParams,key:string):string{const v=(params.get(key)??"").trim();if(!v)throw new Error(`${key} is required`);return v;}
function bool(params:URLSearchParams,key:string):boolean{return params.get(key)==="on"||params.get(key)==="true";}
function positiveInt(raw:string,label:string):number{const value=Number(raw);if(!Number.isInteger(value)||value<0)throw new Error(`${label} must be a non-negative integer`);return value;}

interface SignedChange {kind:"PROGRAM"|"RHYTHM"|"CALENDAR";payload:unknown;revision:number;returnTo:string;}

export interface ProductControlCenterHttpOptions {
  password:string;
  username?:string;
  host?:string;
  port?:number;
  now?:()=>string;
  businessDate?:()=>string;
}

export class ProductControlCenterHttpServer {
  private server:Server|undefined;
  private readonly csrf=randomBytes(24).toString("hex");
  private readonly signingSecret=randomBytes(32).toString("hex");
  private readonly now:()=>string;
  private readonly businessDate:()=>string;

  constructor(
    private readonly config:DistributionConfigurationStorePort,
    private readonly runtime:ControlCenterRuntimePort,
    private readonly options:ProductControlCenterHttpOptions
  ){
    if(!options.password)throw new Error("Control Center password is required");
    this.now=options.now??(()=>new Date().toISOString());
    this.businessDate=options.businessDate??(()=>new Date(this.now()).toISOString().slice(0,10));
  }

  private authorized(req:IncomingMessage):boolean{const auth=parseBasic(req.headers.authorization);return Boolean(auth&&auth.username===(this.options.username??"flerdvision")&&auth.password===this.options.password);}
  private deny(res:ServerResponse):void{res.statusCode=401;res.setHeader("WWW-Authenticate",'Basic realm="Flerdvision Control"');res.end("Authentication required");}
  private redirect(res:ServerResponse,location:string):void{res.statusCode=303;res.setHeader("Location",location);res.end();}
  private shell(title:string,current:string,body:string):string{
    const nav=[
      ["/today","Today"],["/programs","Programs"],["/content","Content"],["/sources","Sources"],["/channels","Channels"],
      ["/profiles","Profiles"],["/rhythms","Rhythms"],["/test-lab","Test Lab"],["/incidents","Incidents"],["/activity","Activity"]
    ].map(([href,label])=>`<a class="${current===href?"active":""}" href="${href}">${label}</a>`).join("");
    return `<!doctype html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#18221f;background:#f5f7f6}.layout{display:grid;grid-template-columns:210px 1fr;min-height:100vh}nav{background:white;border-right:1px solid #dfe5e2;padding:22px 14px}nav h1{font-size:18px;margin:0 8px 20px}nav a{display:block;padding:9px 10px;border-radius:7px;text-decoration:none;color:#34433f;margin:2px 0}nav a.active{background:#e4f2ef;color:#075e58;font-weight:650}main{padding:28px;max-width:1380px}.card{background:white;border:1px solid #dfe5e2;border-radius:11px;padding:16px 18px;margin:13px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.kpi{font-size:28px;font-weight:750}.muted{color:#697671}.ok{color:#21704a}.warn{color:#8a6516}.bad{color:#aa392f}.pill{display:inline-block;padding:2px 7px;border-radius:999px;background:#edf1ef;font-size:12px}.program{border-left:4px solid #0e6b64}.program.warn{border-left-color:#b57919}.program.bad{border-left-color:#aa392f}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #e7ecea;text-align:left;vertical-align:top}input,select,textarea,button{font:inherit;padding:7px 8px;margin:3px 2px;border:1px solid #bec8c5;border-radius:6px}button{cursor:pointer;background:white}button.primary{background:#0e6b64;color:white;border-color:#0e6b64}.target-row{display:grid;grid-template-columns:1.2fr 1.2fr 1fr 1fr 1fr .7fr auto;gap:6px;align-items:center;margin:7px 0}code{background:#edf1ef;padding:2px 4px;border-radius:4px}.impact{border-left:4px solid #0e6b64;background:#f1f8f6}.critical{border-left:4px solid #aa392f}.attention{border-left:4px solid #b57919}details{margin-top:8px}.bar{height:8px;background:#e6ece9;border-radius:999px;overflow:hidden}.bar>span{display:block;height:100%;background:#0e6b64}
</style></head><body><div class=layout><nav><h1>Flerdvision</h1>${nav}</nav><main>${body}</main></div></body></html>`;
  }

  private async state(date=this.businessDate()){
    const stored=this.config.load();
    const runtime=await this.runtime.snapshot(date);
    const postingProfiles=Object.fromEntries(stored.config.postingProfiles.map(item=>[item.postingProfileId,item]));
    const control=projectControlCenter({plan:runtime.plan,sources:stored.config.sources,lanes:stored.config.lanes,routes:stored.config.routes,postingProfiles,accounts:runtime.accounts,channelReadiness:runtime.channelReadiness,surfaceReadiness:runtime.surfaceReadiness,routeTests:runtime.routeTests,assets:runtime.assets});
    return{stored,runtime,control};
  }

  private async today():Promise<string>{
    const {stored,runtime,control}=await this.state();
    const programs=projectPublishingPrograms({stored,runtime,businessDate:control.today.businessDate});
    const missing=programs.programs.reduce((sum,p)=>sum+p.missingRequiredAssetsToday,0);
    const slots=control.today.slots.map(slot=>`<tr><td><strong>${esc(new Intl.DateTimeFormat("de-AT",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Vienna"}).format(new Date(slot.scheduledFor)))}</strong></td><td>${slot.deliveries.map(d=>`${esc(d.platform)} · <code>${esc(d.accountId)}</code> · <code>${esc(d.assetId)}</code>`).join("<br>")}</td></tr>`).join("");
    const attention=control.attention.filter(item=>item.severity!=="INFO").map(item=>`<div class="card ${item.severity==="CRITICAL"?"critical":"attention"}"><strong>${esc(item.title)}</strong><p>${esc(item.impact)}</p><a href="${esc(item.deepLink)}">Öffnen</a></div>`).join("");
    return this.shell("Today","/today",`<h1>Today · ${esc(control.today.businessDate)}</h1><div class=grid><div class=card><div class=kpi>${control.today.totalDeliveries}</div><div class=muted>Deliveries</div></div><div class=card><div class="kpi ${missing?"bad":"ok"}">${missing}</div><div class=muted>fehlende REQUIRED Videos</div></div><div class=card><div class=kpi>${control.today.backlog}</div><div class=muted>Backlog</div></div><div class=card><div class="kpi ${control.today.gaps?"warn":"ok"}">${control.today.gaps}</div><div class=muted>Plan-Gaps</div></div></div><div class=card><h2>Slots</h2><table><tr><th>Zeit</th><th>Geplant</th></tr>${slots||"<tr><td colspan=2>Noch kein DailyPlan.</td></tr>"}</table></div><h2>Needs attention</h2>${attention||'<div class="card ok">Keine aktiven Planprobleme.</div>'}`);
  }

  private async programsPage():Promise<string>{
    const {stored,runtime}=await this.state();
    const model=projectPublishingPrograms({stored,runtime,businessDate:this.businessDate()});
    const cards=model.programs.map(program=>{
      const total=Math.max(1,program.requiredAssetsToday),pct=Math.min(100,Math.round(program.readyAssetsToday/total*100));
      const targets=program.targets.map(target=>`<tr><td>${esc(target.platform)} · ${esc(target.accountLabel)}</td><td>${esc(target.postingProfileLabel)}</td><td>${target.activeToday?target.rhythm.map(esc).join(" · "):"aus"}</td><td>${esc(target.requirement)}</td><td class="${target.readiness==="READY"?"ok":target.readiness==="BLOCKED"?"bad":"warn"}">${esc(target.readiness)}</td></tr>`).join("");
      const cls=program.contentStatus==="MISSING"?"bad":program.contentStatus==="AT_RISK"?"warn":"";
      return `<div class="card program ${cls}"><h2>${esc(program.laneLabel)}</h2><p class=muted>${esc(program.sourceLabel)} · ${esc(program.folderPath)}${program.creatorId?` · creator <code>${esc(program.creatorId)}</code>`:""}</p><div class=grid><div><strong>Content heute</strong><div class=bar><span style="width:${pct}%"></span></div><p>${program.readyAssetsToday}/${program.requiredAssetsToday} READY · ${program.stabilizingAssetsToday} STABILIZING · ${program.missingRequiredAssetsToday} fehlen</p></div><div><strong>Activation</strong><p>${esc(program.activationMode)}${program.activationStatus?` · ${esc(program.activationStatus)}`:""}</p></div></div><table><tr><th>Target</th><th>Posting Profile</th><th>Heute</th><th>Requirement</th><th>Readiness</th></tr>${targets}</table></div>`;
    }).join("");
    const laneOptions=stored.config.lanes.filter(l=>l.enabled).map(l=>`<option value="${esc(l.laneId)}">${esc(l.displayName)}</option>`).join("");
    const accountOptions=runtime.accounts.filter(a=>a.enabled).map(a=>`<option value="${esc(a.accountId)}">${esc(a.platform)} · @${esc(a.expectedHandle)}</option>`).join("");
    const profileOptions=stored.config.postingProfiles.filter(p=>p.enabled).map(p=>`<option value="${esc(p.postingProfileId)}">${esc(p.platform)} · ${esc(p.displayName)}</option>`).join("");
    const copyOptions=stored.config.copyProfiles.filter(p=>p.enabled).map(p=>`<option value="${esc(p.copyProfileId)}">${esc(p.displayName)}</option>`).join("");
    const scheduleOptions=Object.keys(stored.schedulePolicies).map(id=>`<option value="${esc(id)}">${esc(id)}</option>`).join("");
    const calendarOptions=`<option value="">kein Kalender</option>${(stored.operatingCalendars??[]).filter(c=>c.enabled).map(c=>`<option value="${esc(c.calendarId)}">${esc(c.displayName)}</option>`).join("")}`;
    return this.shell("Programs","/programs",`<h1>Publishing Programs</h1><p class=muted>Ein Program gruppiert die canonical Routes einer Source Lane. Pull: ${model.sourcePolling.activeIntervalMinutes} min (${esc(model.sourcePolling.activeWindow)}), außerhalb ${model.sourcePolling.idleIntervalMinutes} min.</p>${cards||'<div class=card>Noch kein Program.</div>'}<div class=card><h2>Program hinzufügen / Targets ergänzen</h2><form method=post action=/preview/program><input type=hidden name=csrf value=${this.csrf}><input type=hidden name=businessDate value="${esc(this.businessDate())}"><label>Source Lane <select name=laneId>${laneOptions}</select></label><div id=targets><div class=target-row><select name=accountId>${accountOptions}</select><select name=postingProfileId>${profileOptions}</select><select name=copyProfileId>${copyOptions}</select><select name=schedulePolicyId>${scheduleOptions}</select><select name=operatingCalendarId>${calendarOptions}</select><select name=requirement><option>REQUIRED</option><option>OPTIONAL</option></select><button type=button onclick="this.parentElement.remove()">×</button></div></div><button type=button onclick="const t=document.querySelector('.target-row');document.querySelector('#targets').append(t.cloneNode(true))">+ Target</button><button class=primary>Auswirkungen prüfen</button></form></div>`);
  }

  private async contentPage():Promise<string>{
    const {stored,runtime}=await this.state();
    const rows=projectContentQueue({assets:runtime.assets,plan:runtime.plan,lanes:stored.config.lanes,routes:stored.config.routes,aggregates:runtime.deliveryAggregates});
    const html=rows.map(item=>`<tr><td><strong>${esc(item.filename)}</strong><br><code>${esc(item.assetId)}</code></td><td>${esc(item.laneName)}</td><td class="${item.status==="BLOCKED"?"bad":item.status==="PARTIAL"?"warn":item.status==="COMPLETE"?"ok":""}">${esc(item.status)}</td><td>${item.targetAccountIds.map(esc).join("<br>")||"—"}</td><td>${item.scheduledFor.map(value=>esc(new Date(value).toLocaleString("de-AT",{timeZone:"Europe/Vienna"}))).join("<br>")||"—"}</td></tr>`).join("");
    return this.shell("Content","/content",`<h1>Content</h1><div class=card><table><tr><th>Datei</th><th>Lane</th><th>Status</th><th>Targets</th><th>Geplant</th></tr>${html||"<tr><td colspan=5>Keine Assets.</td></tr>"}</table></div>`);
  }

  private async sourcesPage():Promise<string>{
    const {stored,runtime}=await this.state();
    const activation=new Map((runtime.sourceActivation??[]).map(item=>[item.laneId,item]));
    const cursors=new Map(stored.config.activationCursors.map(item=>[item.laneId,item]));
    const sources=stored.config.sources.map(source=>`<tr><td>${esc(source.displayName)}</td><td>${esc(source.kind)}</td><td><code>${esc(source.rootRef)}</code></td><td>${esc(source.disposition.mode)}</td><td>${source.enabled?"✓":"paused"}</td></tr>`).join("");
    const lanes=stored.config.lanes.map(lane=>{const cursor=cursors.get(lane.laneId),status=activation.get(lane.laneId);return`<tr><td>${esc(lane.displayName)}</td><td>${esc(lane.folderPath)}</td><td>${lane.creatorId?esc(lane.creatorId):"—"}</td><td>${cursor?esc(cursor.mode):'<span class=bad>missing</span>'}</td><td>${status?esc(status.state):"not evaluated"}</td></tr>`;}).join("");
    return this.shell("Sources","/sources",`<h1>Sources</h1><div class=card><h2>Connections</h2><table><tr><th>Name</th><th>Typ</th><th>Root</th><th>Disposition</th><th>Status</th></tr>${sources}</table></div><div class=card><h2>Lanes</h2><table><tr><th>Lane</th><th>Folder</th><th>Creator</th><th>Activation</th><th>Runtime</th></tr>${lanes}</table><p class=muted>Source-/Lane-Erstellung bleibt aktuell im Onboarding; Program-Verknüpfungen passieren hier nicht mehr über den alten One-Folder-per-Account-Wizard.</p></div>`);
  }

  private async channelsPage():Promise<string>{
    const {runtime}=await this.state();
    const readiness=new Map(runtime.channelReadiness.map(item=>[item.accountId,item]));
    const rows=runtime.accounts.map(account=>{const r=readiness.get(account.accountId);return`<tr><td>${esc(account.platform)}</td><td>@${esc(account.expectedHandle)}</td><td><code>${esc(account.accountId)}</code></td><td>${r?esc(r.sessionHealth):"UNKNOWN"}</td><td>${r?.identityVerified?'<span class=ok>VERIFIED</span>':'<span class=bad>NOT VERIFIED</span>'}</td></tr>`;}).join("");
    return this.shell("Channels","/channels",`<h1>Channels</h1><div class=card><table><tr><th>Platform</th><th>Handle</th><th>Account ID</th><th>Session</th><th>Identity</th></tr>${rows||"<tr><td colspan=5>Keine Channels.</td></tr>"}</table></div>`);
  }

  private async profilesPage():Promise<string>{
    const {stored}=await this.state();
    const rows=stored.config.postingProfiles.map(p=>`<tr><td>${esc(p.displayName)}</td><td>${esc(p.platform)}</td><td>${esc(p.format)}</td><td>${"visibility" in p?esc(String(p.visibility)):"—"}</td><td>${p.enabled?"✓":"paused"}</td></tr>`).join("");
    return this.shell("Profiles","/profiles",`<h1>Posting Profiles</h1><div class=card><table><tr><th>Name</th><th>Platform</th><th>Format</th><th>Visibility</th><th>Status</th></tr>${rows}</table></div>`);
  }

  private async rhythmsPage():Promise<string>{
    const {stored}=await this.state();
    const schedules=Object.entries(stored.schedulePolicies).map(([id,p])=>`<tr><td><code>${esc(id)}</code></td><td>${p.slots.map(s=>esc(s.localTime)).join(" · ")}</td><td>±${p.windowMinutes} min</td><td>${p.maxPerAccountPerBusinessDate}</td><td>${p.minimumSpacingMinutes} min</td></tr>`).join("");
    const calendars=(stored.operatingCalendars??[]).map(c=>`<tr><td>${esc(c.displayName)}<br><code>${esc(c.calendarId)}</code></td><td>${c.weekdayRules.map(r=>`${r.isoWeekday}:${r.active?(r.schedulePolicyId??"default"):"off"}`).join(" · ")||"default every day"}</td><td>${c.dateOverrides.length}</td><td>${c.enabled?"✓":"paused"}</td></tr>`).join("");
    return this.shell("Rhythms","/rhythms",`<h1>Rhythms & Calendars</h1><div class=card><h2>Schedule Policies</h2><table><tr><th>ID</th><th>Slots</th><th>Window</th><th>Cap/day</th><th>Spacing</th></tr>${schedules}</table><details><summary>Rhythm anlegen / ändern</summary><form method=post action=/preview/rhythm><input type=hidden name=csrf value=${this.csrf}><input name=schedulePolicyId placeholder="standard-4x" required><input name=timeZone value="Europe/Vienna" required><input name=slots placeholder="slot-1@09:00,slot-2@11:00,slot-3@15:00,slot-4@17:00" required><input name=windowMinutes type=number value=30 min=0><input name=maxPerDay type=number value=4 min=1><input name=minimumSpacingMinutes type=number value=120 min=0><button>Auswirkungen prüfen</button></form></details></div><div class=card><h2>Operating Calendars</h2><table><tr><th>Kalender</th><th>Weekdays (1=Mo)</th><th>Date overrides</th><th>Status</th></tr>${calendars||"<tr><td colspan=4>Keine Kalender; Routes gelten täglich mit ihrem Default-Rhythmus.</td></tr>"}</table><details><summary>Kalender anlegen / ändern</summary><form method=post action=/preview/calendar><input type=hidden name=csrf value=${this.csrf}><input name=calendarId placeholder="weekday" required><input name=displayName placeholder="Mo–Fr" required><label><input type=checkbox name=enabled checked> enabled</label><p class=muted>Weekdays: eine Zeile je Tag: <code>1|on|standard-4x</code> oder <code>7|off</code>. Date overrides: <code>2026-12-24|on|holiday-2x|Christmas Eve</code>.</p><textarea name=weekdays rows=7 placeholder="1|on\n2|on\n3|on\n4|on\n5|on\n6|off\n7|off"></textarea><textarea name=dates rows=5 placeholder="2026-12-24|on|holiday-2x|Christmas Eve"></textarea><button>Auswirkungen prüfen</button></form></details></div>`);
  }

  private async testLabPage():Promise<string>{
    const {stored,runtime}=await this.state();
    const tests=new Map(runtime.routeTests.map(item=>[item.routeId,item]));
    const rows=stored.config.routes.map(route=>{const t=tests.get(route.routeId);return`<tr><td>${esc(route.displayName)}</td><td>${t?.sourcePassed?"✓":"—"}</td><td>${t?.sessionPassed?"✓":"—"}</td><td>${t?.identityPassed?"✓":"—"}</td><td>${t?.prepareOnlyPasses??0}/3</td><td>${t?.verificationPassed?"✓":"—"}</td><td>${t?.releaseSha?`<code>${esc(t.releaseSha.slice(0,10))}</code>`:"—"}</td></tr>`;}).join("");
    return this.shell("Test Lab","/test-lab",`<h1>Route Test Lab</h1><p class=muted>Plan sichtbar heißt nicht ausführbar. Runnable Intents entstehen erst nach kompletter Route-Qualifikation.</p><div class=card><table><tr><th>Route</th><th>Source</th><th>Session</th><th>Identity</th><th>Prepare</th><th>Verify</th><th>Release</th></tr>${rows||"<tr><td colspan=7>Keine Routes.</td></tr>"}</table></div>`);
  }

  private async incidentsPage():Promise<string>{
    const {runtime}=await this.state();
    const cards=(runtime.incidents??[]).map(incident=>{const v=incidentView(incident);return`<div class="card ${v.severity==="CRITICAL"?"critical":"attention"}"><strong>${esc(v.title)}</strong><p>${esc(v.summary)}</p><p>${esc(v.impact)}</p><p>Actions: ${v.allowedActions.map(a=>`<span class=pill>${esc(a)}</span>`).join(" ")}</p>${v.prohibitedAction?`<p class=bad>${esc(v.prohibitedAction)}</p>`:""}</div>`;}).join("");
    return this.shell("Incidents","/incidents",`<h1>Incidents</h1>${cards||'<div class="card ok">Keine offenen Incidents.</div>'}`);
  }

  private async activityPage():Promise<string>{
    const {runtime}=await this.state();
    const rows=projectActivity(runtime.auditEvents??[],200).map(item=>`<tr><td>${esc(new Date(item.occurredAt).toLocaleString("de-AT",{timeZone:"Europe/Vienna"}))}</td><td>${esc(item.kind)}</td><td>${esc(item.summary)}</td></tr>`).join("");
    return this.shell("Activity","/activity",`<h1>Activity</h1><div class=card><table><tr><th>Zeit</th><th>Event</th><th>Details</th></tr>${rows||"<tr><td colspan=3>Noch keine Audit-Events projiziert.</td></tr>"}</table></div>`);
  }

  private sign(change:SignedChange):{payload:string;signature:string}{const payload=Buffer.from(JSON.stringify(change),"utf8").toString("base64url");return{payload,signature:createHash("sha256").update(`${this.signingSecret}|${payload}|${this.signingSecret}`).digest("hex")};}
  private verify(payload:string,signature:string):SignedChange{const expected=createHash("sha256").update(`${this.signingSecret}|${payload}|${this.signingSecret}`).digest("hex");if(expected!==signature)throw new Error("Preview signature invalid");return JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as SignedChange;}
  private impactPage(change:SignedChange,title:string,summary:string,details:string):string{const signed=this.sign(change);return this.shell("Auswirkungen","",`<h1>${esc(title)}</h1><div class="card impact"><p>${esc(summary)}</p>${details}</div><form method=post action=/apply><input type=hidden name=csrf value=${this.csrf}><input type=hidden name=payload value="${esc(signed.payload)}"><input type=hidden name=signature value="${esc(signed.signature)}"><button class=primary>Änderung bestätigen</button> <a href="${esc(change.returnTo)}">Abbrechen</a></form>`);}

  private programDraft(params:URLSearchParams):PublishingProgramDraft{
    const laneId=required(params,"laneId"),businessDate=(params.get("businessDate")??"").trim()||undefined;
    const accounts=params.getAll("accountId"),profiles=params.getAll("postingProfileId"),copies=params.getAll("copyProfileId"),schedules=params.getAll("schedulePolicyId"),calendars=params.getAll("operatingCalendarId"),requirements=params.getAll("requirement");
    if(accounts.length===0)throw new Error("At least one target is required");
    const targets=accounts.map((accountId,index)=>({
      accountId,
      postingProfileId:profiles[index]??"",
      copyProfileId:copies[index]??"",
      schedulePolicyId:schedules[index]??"",
      ...(calendars[index]?{operatingCalendarId:calendars[index]}:{}),
      requirement:requirements[index]==="OPTIONAL"?"OPTIONAL" as const:"REQUIRED" as const,
      enabled:true
    }));
    return{laneId,...(businessDate?{businessDate}:{}),targets};
  }

  private rhythmFrom(params:URLSearchParams):{id:string;policy:SchedulingPolicy}{
    const id=required(params,"schedulePolicyId"),slots=required(params,"slots").split(",").map(part=>part.trim()).filter(Boolean).map((part,index)=>{const [key,time]=part.includes("@")?part.split("@",2):[`slot-${index+1}`,part];if(!key||!time)throw new Error(`Invalid slot: ${part}`);return{key:key.trim(),localTime:time.trim()};});
    return{id,policy:{timeZone:required(params,"timeZone"),slots,windowMinutes:positiveInt(required(params,"windowMinutes"),"windowMinutes"),maxPerAccountPerBusinessDate:positiveInt(required(params,"maxPerDay"),"maxPerDay"),minimumSpacingMinutes:positiveInt(required(params,"minimumSpacingMinutes"),"minimumSpacingMinutes"),overflowAllowed:false,overflowMinimumSpacingMinutes:240}};
  }

  private calendarFrom(params:URLSearchParams):OperatingCalendar{
    const weekdays:OperatingCalendarWeekdayRule[]=[];
    for(const line of (params.get("weekdays")??"").split("\n").map(v=>v.trim()).filter(Boolean)){
      const [day,rawActive,schedule]=line.split("|").map(v=>v.trim());const n=Number(day);if(!Number.isInteger(n)||n<1||n>7)throw new Error(`Invalid ISO weekday: ${day}`);weekdays.push({isoWeekday:n as 1|2|3|4|5|6|7,active:rawActive!=="off",...(schedule?{schedulePolicyId:schedule}:{})});
    }
    const dates:OperatingCalendarDateOverride[]=[];
    for(const line of (params.get("dates")??"").split("\n").map(v=>v.trim()).filter(Boolean)){
      const [businessDate,rawActive,schedule,note]=line.split("|").map(v=>v.trim());if(!businessDate)throw new Error("Date override requires businessDate");dates.push({businessDate,active:rawActive!=="off",...(schedule?{schedulePolicyId:schedule}:{}),...(note?{note}:{})});
    }
    return{calendarId:required(params,"calendarId"),displayName:required(params,"displayName"),enabled:bool(params,"enabled"),weekdayRules:weekdays,dateOverrides:dates};
  }

  private async preview(path:string,params:URLSearchParams):Promise<string>{
    if(path==="/preview/program"){
      const snapshot=await this.runtime.snapshot(this.businessDate());const draft=this.programDraft(params);const service=new PublishingProgramManagementService(this.config,()=>snapshot.accounts);const preview=service.preview(draft);const change:SignedChange={kind:"PROGRAM",payload:draft,revision:preview.currentRevision,returnTo:"/programs"};
      const rhythms=preview.rhythms.map(r=>`<li><code>${esc(r.routeId)}</code> · ${r.active?r.slots.map(esc).join(" / "):"aus"} · ${esc(r.source)}</li>`).join("");return this.impactPage(change,"Program-Auswirkungen",`${preview.affectedRouteIds.length} Route(s), ${preview.requiredAssetCountPerBusinessDate} Quellvideo(s) für den Preview-Tag.`,`<ul>${rhythms}</ul><p>Bestehende verified Publikationen bleiben unverändert. Neue/änderte Routes müssen Route-Qualifikation bestehen.</p>`);
    }
    const service=new RhythmCalendarManagementService(this.config);
    if(path==="/preview/rhythm"){
      const {id,policy}=this.rhythmFrom(params),preview=service.previewSchedulePolicy(id,policy);const change:SignedChange={kind:"RHYTHM",payload:{id,policy},revision:preview.currentRevision,returnTo:"/rhythms"};return this.impactPage(change,"Rhythm-Auswirkungen",preview.operatorSummary,`<p>Betroffene Routes: ${preview.affectedRouteIds.map(id=>`<code>${esc(id)}</code>`).join(" ")||"keine"}</p><p>Committed Deliveries bleiben unverändert; zukünftige uncommitted Pläne werden neu berechnet.</p>`);
    }
    if(path==="/preview/calendar"){
      const calendar=this.calendarFrom(params),preview=service.previewOperatingCalendar(calendar);const change:SignedChange={kind:"CALENDAR",payload:calendar,revision:preview.currentRevision,returnTo:"/rhythms"};return this.impactPage(change,"Kalender-Auswirkungen",preview.operatorSummary,`<p>Betroffene Routes: ${preview.affectedRouteIds.map(id=>`<code>${esc(id)}</code>`).join(" ")||"keine"}</p><p>Committed Deliveries bleiben unverändert.</p>`);
    }
    throw new Error("Unknown preview action");
  }

  private async apply(change:SignedChange):Promise<string>{
    if(change.kind==="PROGRAM"){
      const snapshot=await this.runtime.snapshot(this.businessDate());new PublishingProgramManagementService(this.config,()=>snapshot.accounts).apply(change.payload as PublishingProgramDraft,change.revision,this.now());return change.returnTo;
    }
    const service=new RhythmCalendarManagementService(this.config);
    if(change.kind==="RHYTHM"){const payload=change.payload as {id:string;policy:SchedulingPolicy};service.saveSchedulePolicy(payload.id,payload.policy,change.revision,this.now());return change.returnTo;}
    service.saveOperatingCalendar(change.payload as OperatingCalendar,change.revision,this.now());return change.returnTo;
  }

  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    if(!this.authorized(req)){this.deny(res);return;}
    const method=req.method??"GET",url=new URL(req.url??"/","http://127.0.0.1"),path=url.pathname;
    try{
      if(method==="GET"){
        if(path==="/"){this.redirect(res,"/today");return;}
        const pages:Record<string,()=>Promise<string>>={"/today":()=>this.today(),"/programs":()=>this.programsPage(),"/content":()=>this.contentPage(),"/sources":()=>this.sourcesPage(),"/channels":()=>this.channelsPage(),"/profiles":()=>this.profilesPage(),"/rhythms":()=>this.rhythmsPage(),"/test-lab":()=>this.testLabPage(),"/incidents":()=>this.incidentsPage(),"/activity":()=>this.activityPage()};
        const render=pages[path];if(!render){res.statusCode=404;res.end("Not found");return;}const html=await render();res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;
      }
      if(method!=="POST"){res.statusCode=404;res.end("Not found");return;}
      const params=await form(req);if(params.get("csrf")!==this.csrf){res.statusCode=403;res.end("Invalid CSRF token");return;}
      if(path.startsWith("/preview/")){const html=await this.preview(path,params);res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;}
      if(path==="/apply"){const change=this.verify(required(params,"payload"),required(params,"signature"));const destination=await this.apply(change);this.redirect(res,destination);return;}
      res.statusCode=404;res.end("Not found");
    }catch(error){res.statusCode=error instanceof DistributionConfigurationRevisionConflict?409:400;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end(error instanceof Error?error.message:String(error));}
  }

  async start():Promise<{host:string;port:number}>{if(this.server)throw new Error("Control Center already started");const host=this.options.host??"127.0.0.1",port=this.options.port??0;this.server=createServer((req,res)=>{void this.handle(req,res);});await new Promise<void>(resolve=>this.server!.listen(port,host,resolve));const address=this.server.address();if(!address||typeof address==="string")throw new Error("Control Center did not expose TCP address");return{host,port:address.port};}
  async stop():Promise<void>{if(!this.server)return;const server=this.server;this.server=undefined;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
