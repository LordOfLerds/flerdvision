import type { ControlCenterRuntimeSnapshot } from "../../domain/control-center-ports.js";
import type { StoredDistributionConfiguration } from "../../domain/distribution-ports.js";
import type { RouteTestCommandPort } from "../../domain/route-test-command-ports.js";
import { projectPublishingPrograms } from "../../application/publishing-program-read-model.js";
import { projectContentQueue } from "../../application/control-center-content.js";
import { projectControlCenter } from "../../application/control-center-read-model.js";
import { buildRouteTestMatrix } from "../../application/route-test-matrix.js";
import { incidentView } from "../../application/control-center-operator-surfaces.js";
import { projectActivity } from "../../application/control-center-activity.js";
import { projectWorkflowCenter } from "../../application/workflow-center.js";

export function escapeProductHtml(value:string):string{return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
const esc=escapeProductHtml;

export interface ProductControlPageContext {
  path:string;
  stored:StoredDistributionConfiguration;
  runtime:ControlCenterRuntimeSnapshot;
  businessDate:string;
  csrf:string;
  routeTests?:RouteTestCommandPort;
}

function shell(title:string,current:string,body:string):string{
  const nav=[["/today","Today"],["/workflows","Workflows"],["/programs","Programs"],["/content","Content"],["/sources","Sources"],["/channels","Channels"],["/profiles","Profiles"],["/rhythms","Rhythms"],["/test-lab","Test Lab"],["/incidents","Incidents"],["/activity","Activity"]]
    .map(([href,label])=>`<a class="${current===href?"active":""}" href="${href}">${label}</a>`).join("");
  return `<!doctype html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#18221f;background:#f5f7f6}.layout{display:grid;grid-template-columns:210px 1fr;min-height:100vh}nav{background:#fff;border-right:1px solid #dfe5e2;padding:22px 14px}nav h1{font-size:18px;margin:0 8px 20px}nav a{display:block;padding:9px 10px;border-radius:7px;text-decoration:none;color:#34433f;margin:2px 0}nav a.active{background:#e4f2ef;color:#075e58;font-weight:650}main{padding:28px;max-width:1380px}.card{background:#fff;border:1px solid #dfe5e2;border-radius:11px;padding:16px 18px;margin:13px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}.kpi{font-size:28px;font-weight:750}.muted{color:#697671}.ok{color:#21704a}.warn{color:#8a6516}.bad{color:#aa392f}.pill{display:inline-block;padding:2px 7px;border-radius:999px;background:#edf1ef;font-size:12px}.program{border-left:4px solid #0e6b64}.program.warn{border-left-color:#b57919}.program.bad{border-left-color:#aa392f}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #e7ecea;text-align:left;vertical-align:top}input,select,textarea,button{font:inherit;padding:7px 8px;margin:3px 2px;border:1px solid #bec8c5;border-radius:6px}button{cursor:pointer;background:#fff}button.primary{background:#0e6b64;color:#fff;border-color:#0e6b64}button:disabled{cursor:not-allowed;opacity:.45}.target-row{display:grid;grid-template-columns:1.2fr 1.2fr 1fr 1fr 1fr .7fr auto;gap:6px;align-items:center;margin:7px 0}code{background:#edf1ef;padding:2px 4px;border-radius:4px}.critical{border-left:4px solid #aa392f}.attention{border-left:4px solid #b57919}.bar{height:8px;background:#e6ece9;border-radius:999px;overflow:hidden}.bar>span{display:block;height:100%;background:#0e6b64}.test-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.test-case{border:1px solid #e1e7e4;border-radius:8px;padding:10px}.test-case h4{margin:0 0 5px}
</style></head><body><div class=layout><nav><h1>Flerdvision</h1>${nav}</nav><main>${body}</main></div></body></html>`;
}

function control(ctx:ProductControlPageContext){
  const postingProfiles=Object.fromEntries(ctx.stored.config.postingProfiles.map(item=>[item.postingProfileId,item]));
  return projectControlCenter({plan:ctx.runtime.plan,sources:ctx.stored.config.sources,lanes:ctx.stored.config.lanes,routes:ctx.stored.config.routes,postingProfiles,accounts:ctx.runtime.accounts,channelReadiness:ctx.runtime.channelReadiness,...(ctx.runtime.surfaceReadiness ? { surfaceReadiness: ctx.runtime.surfaceReadiness } : {}),routeTests:ctx.runtime.routeTests,assets:ctx.runtime.assets});
}

function today(ctx:ProductControlPageContext):string{
  const model=control(ctx),programs=projectPublishingPrograms({stored:ctx.stored,runtime:ctx.runtime,businessDate:ctx.businessDate});
  const missing=programs.programs.reduce((sum,p)=>sum+p.missingRequiredAssetsToday,0);
  const slots=model.today.slots.map(slot=>`<tr><td><strong>${esc(new Intl.DateTimeFormat("de-AT",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Vienna"}).format(new Date(slot.scheduledFor)))}</strong></td><td>${slot.deliveries.map(d=>`${esc(d.platform)} · <code>${esc(d.accountId)}</code> · <code>${esc(d.assetId)}</code>`).join("<br>")}</td></tr>`).join("");
  const attention=model.attention.filter(item=>item.severity!=="INFO").map(item=>`<div class="card ${item.severity==="CRITICAL"?"critical":"attention"}"><strong>${esc(item.title)}</strong><p>${esc(item.impact)}</p><a href="${esc(item.deepLink)}">Öffnen</a></div>`).join("");
  return shell("Today","/today",`<h1>Today · ${esc(ctx.businessDate)}</h1><div class=grid><div class=card><div class=kpi>${model.today.totalDeliveries}</div><div class=muted>Deliveries</div></div><div class=card><div class="kpi ${missing?"bad":"ok"}">${missing}</div><div class=muted>fehlende REQUIRED Videos</div></div><div class=card><div class=kpi>${model.today.backlog}</div><div class=muted>Backlog</div></div><div class=card><div class="kpi ${model.today.gaps?"warn":"ok"}">${model.today.gaps}</div><div class=muted>Plan-Gaps</div></div></div><div class=card><h2>Slots</h2><table><tr><th>Zeit</th><th>Geplant</th></tr>${slots||"<tr><td colspan=2>Noch kein DailyPlan.</td></tr>"}</table></div><h2>Needs attention</h2>${attention||'<div class="card ok">Keine aktiven Planprobleme.</div>'}`);
}

function workflows(ctx:ProductControlPageContext):string{
  const model=projectWorkflowCenter({stored:ctx.stored,runtime:ctx.runtime,businessDate:ctx.businessDate});
  const cards=model.cards.map(item=>{
    const cls=item.status==="BLOCKED"?"bad":item.status==="NEEDS_ACTION"?"warn":"";
    const statusClass=item.status==="READY"?"ok":item.status==="BLOCKED"?"bad":"warn";
    const metrics=Object.entries(item.metrics).map(([key,value])=>`<span class=pill>${esc(key)}: ${esc(String(value))}</span>`).join(" ");
    return`<div class="card program ${cls}"><div style="display:flex;justify-content:space-between;gap:16px;align-items:start"><div><h2 style="margin-top:0">${esc(item.label)}</h2><p class=muted>${esc(item.purpose)}</p></div><strong class="${statusClass}">${esc(item.status)}</strong></div><p>${esc(item.detail)}</p><p>${metrics}</p><a href="${esc(item.deepLink)}">Workflow öffnen</a></div>`;
  }).join("");
  return shell("Workflows","/workflows",`<h1>Operational Workflows · ${esc(model.businessDate)}</h1><p class=muted>Eine Sicht über Source → Plan → Route Qualification → Delivery/Reconciliation. SAFE_FROZEN bedeutet: funktional vorbereitet, Final Publish bleibt absichtlich außerhalb des normalen Produktpfads.</p><div class=grid><div class=card><div class="kpi ok">${model.summary.ready}</div><div class=muted>READY</div></div><div class=card><div class="kpi warn">${model.summary.needsAction}</div><div class=muted>NEEDS ACTION</div></div><div class=card><div class="kpi bad">${model.summary.blocked}</div><div class=muted>BLOCKED</div></div><div class=card><div class="kpi warn">${model.summary.safeFrozen}</div><div class=muted>SAFE FROZEN</div></div></div>${cards}`);
}

function programs(ctx:ProductControlPageContext):string{
  const model=projectPublishingPrograms({stored:ctx.stored,runtime:ctx.runtime,businessDate:ctx.businessDate});
  const cards=model.programs.map(program=>{
    const total=Math.max(1,program.requiredAssetsToday),pct=Math.min(100,Math.round(program.readyAssetsToday/total*100));
    const targets=program.targets.map(target=>`<tr><td>${esc(target.platform)} · ${esc(target.accountLabel)}</td><td>${esc(target.postingProfileLabel)}</td><td>${target.activeToday?target.rhythm.map(esc).join(" · "):"aus"}${target.operatingCalendarId?`<br><small>${esc(target.calendarSource)}</small>`:""}</td><td>${esc(target.requirement)}</td><td class="${target.readiness==="READY"?"ok":target.readiness==="BLOCKED"?"bad":"warn"}">${esc(target.readiness)}</td></tr>`).join("");
    const cls=program.contentStatus==="MISSING"?"bad":program.contentStatus==="AT_RISK"?"warn":"";
    return `<div class="card program ${cls}"><h2>${esc(program.laneLabel)}</h2><p class=muted>${esc(program.sourceLabel)} · ${esc(program.folderPath)}${program.creatorId?` · creator <code>${esc(program.creatorId)}</code>`:""}</p><div class=grid><div><strong>Content heute</strong><div class=bar><span style="width:${pct}%"></span></div><p>${program.readyAssetsToday}/${program.requiredAssetsToday} READY · ${program.stabilizingAssetsToday} STABILIZING · ${program.missingRequiredAssetsToday} fehlen</p></div><div><strong>Activation</strong><p>${esc(program.activationMode)}${program.activationStatus?` · ${esc(program.activationStatus)}`:""}</p></div></div><table><tr><th>Target</th><th>Posting Profile</th><th>Heute</th><th>Requirement</th><th>Readiness</th></tr>${targets}</table></div>`;
  }).join("");
  const laneOptions=ctx.stored.config.lanes.filter(l=>l.enabled).map(l=>`<option value="${esc(l.laneId)}">${esc(l.displayName)}</option>`).join("");
  const accountOptions=ctx.runtime.accounts.filter(a=>a.enabled).map(a=>`<option value="${esc(a.accountId)}">${esc(a.platform)} · @${esc(a.expectedHandle)}</option>`).join("");
  const profileOptions=ctx.stored.config.postingProfiles.filter(p=>p.enabled).map(p=>`<option value="${esc(p.postingProfileId)}">${esc(p.platform)} · ${esc(p.displayName)}</option>`).join("");
  const copyOptions=ctx.stored.config.copyProfiles.filter(p=>p.enabled).map(p=>`<option value="${esc(p.copyProfileId)}">${esc(p.displayName)}</option>`).join("");
  const scheduleOptions=Object.keys(ctx.stored.schedulePolicies).map(id=>`<option value="${esc(id)}">${esc(id)}</option>`).join("");
  const calendarOptions=`<option value="">kein Kalender</option>${(ctx.stored.operatingCalendars??[]).filter(c=>c.enabled).map(c=>`<option value="${esc(c.calendarId)}">${esc(c.displayName)}</option>`).join("")}`;
  return shell("Programs","/programs",`<h1>Publishing Programs</h1><p class=muted>Pull: ${model.sourcePolling.activeIntervalMinutes} min (${esc(model.sourcePolling.activeWindow)}), außerhalb ${model.sourcePolling.idleIntervalMinutes} min. Programs sind UX; gespeichert bleiben canonical Routes.</p>${cards||'<div class=card>Noch kein Program.</div>'}<div class=card><h2>Program hinzufügen / Targets ergänzen</h2><form method=post action=/preview/program><input type=hidden name=csrf value=${ctx.csrf}><input type=hidden name=businessDate value="${esc(ctx.businessDate)}"><label>Source Lane <select name=laneId>${laneOptions}</select></label><div id=targets><div class=target-row><select name=accountId>${accountOptions}</select><select name=postingProfileId>${profileOptions}</select><select name=copyProfileId>${copyOptions}</select><select name=schedulePolicyId>${scheduleOptions}</select><select name=operatingCalendarId>${calendarOptions}</select><select name=requirement><option>REQUIRED</option><option>OPTIONAL</option></select><button type=button onclick="this.parentElement.remove()">×</button></div></div><button type=button onclick="const t=document.querySelector('.target-row');document.querySelector('#targets').append(t.cloneNode(true))">+ Target</button><button class=primary>Auswirkungen prüfen</button></form></div>`);
}

function content(ctx:ProductControlPageContext):string{
  const rows=projectContentQueue({assets:ctx.runtime.assets,plan:ctx.runtime.plan,lanes:ctx.stored.config.lanes,routes:ctx.stored.config.routes,...(ctx.runtime.deliveryAggregates ? { aggregates: ctx.runtime.deliveryAggregates } : {})});
  const html=rows.map(item=>`<tr><td><strong>${esc(item.filename)}</strong><br><code>${esc(item.assetId)}</code></td><td>${esc(item.laneName)}</td><td class="${item.status==="BLOCKED"?"bad":item.status==="PARTIAL"?"warn":item.status==="COMPLETE"?"ok":""}">${esc(item.status)}</td><td>${item.targetAccountIds.map(esc).join("<br>")||"—"}</td><td>${item.scheduledFor.map(value=>esc(new Date(value).toLocaleString("de-AT",{timeZone:"Europe/Vienna"}))).join("<br>")||"—"}</td></tr>`).join("");
  return shell("Content","/content",`<h1>Content</h1><div class=card><table><tr><th>Datei</th><th>Lane</th><th>Status</th><th>Targets</th><th>Geplant</th></tr>${html||"<tr><td colspan=5>Keine Assets.</td></tr>"}</table></div>`);
}

function sources(ctx:ProductControlPageContext):string{
  const activation=new Map((ctx.runtime.sourceActivation??[]).map(item=>[item.laneId,item])),cursors=new Map(ctx.stored.config.activationCursors.map(item=>[item.laneId,item]));
  const sourceRows=ctx.stored.config.sources.map(source=>`<tr><td>${esc(source.displayName)}</td><td>${esc(source.kind)}</td><td><code>${esc(source.rootRef)}</code></td><td>${esc(source.disposition.mode)}</td><td>${source.enabled?"✓":"paused"}</td></tr>`).join("");
  const lanes=ctx.stored.config.lanes.map(lane=>{const cursor=cursors.get(lane.laneId),status=activation.get(lane.laneId);return`<tr><td>${esc(lane.displayName)}</td><td>${esc(lane.folderPath)}</td><td>${lane.creatorId?esc(lane.creatorId):"—"}</td><td>${cursor?esc(cursor.mode):'<span class=bad>missing</span>'}</td><td>${status?esc(status.state):"not evaluated"}</td></tr>`;}).join("");
  return shell("Sources","/sources",`<h1>Sources</h1><div class=card><h2>Connections</h2><table><tr><th>Name</th><th>Typ</th><th>Root</th><th>Disposition</th><th>Status</th></tr>${sourceRows}</table></div><div class=card><h2>Lanes</h2><table><tr><th>Lane</th><th>Folder</th><th>Creator</th><th>Activation</th><th>Runtime</th></tr>${lanes}</table></div>`);
}

function channels(ctx:ProductControlPageContext):string{
  const readiness=new Map(ctx.runtime.channelReadiness.map(item=>[item.accountId,item]));
  const rows=ctx.runtime.accounts.map(account=>{const r=readiness.get(account.accountId);return`<tr><td>${esc(account.platform)}</td><td>@${esc(account.expectedHandle)}</td><td><code>${esc(account.accountId)}</code></td><td>${r?esc(r.sessionHealth):"UNKNOWN"}</td><td>${r?.identityVerified?'<span class=ok>VERIFIED</span>':'<span class=bad>NOT VERIFIED</span>'}</td></tr>`;}).join("");
  return shell("Channels","/channels",`<h1>Channels</h1><div class=card><table><tr><th>Platform</th><th>Handle</th><th>Account ID</th><th>Session</th><th>Identity</th></tr>${rows||"<tr><td colspan=5>Keine Channels.</td></tr>"}</table></div>`);
}

function profiles(ctx:ProductControlPageContext):string{
  const rows=ctx.stored.config.postingProfiles.map(p=>`<tr><td>${esc(p.displayName)}</td><td>${esc(p.platform)}</td><td>${esc(p.format)}</td><td>${"visibility" in p?esc(String(p.visibility)):"—"}</td><td>${p.enabled?"✓":"paused"}</td></tr>`).join("");
  return shell("Profiles","/profiles",`<h1>Posting Profiles</h1><div class=card><table><tr><th>Name</th><th>Platform</th><th>Format</th><th>Visibility</th><th>Status</th></tr>${rows}</table></div>`);
}

function rhythms(ctx:ProductControlPageContext):string{
  const schedules=Object.entries(ctx.stored.schedulePolicies).map(([id,p])=>`<tr><td><code>${esc(id)}</code></td><td>${p.slots.map(s=>esc(s.localTime)).join(" · ")}</td><td>±${p.windowMinutes} min</td><td>${p.maxPerAccountPerBusinessDate}</td><td>${p.minimumSpacingMinutes} min</td></tr>`).join("");
  const calendars=(ctx.stored.operatingCalendars??[]).map(c=>`<tr><td>${esc(c.displayName)}<br><code>${esc(c.calendarId)}</code></td><td>${c.weekdayRules.map(r=>`${r.isoWeekday}:${r.active?(r.schedulePolicyId??"default"):"off"}`).join(" · ")||"default every day"}</td><td>${c.dateOverrides.length}</td><td>${c.enabled?"✓":"paused"}</td></tr>`).join("");
  return shell("Rhythms","/rhythms",`<h1>Rhythms & Calendars</h1><div class=card><h2>Schedule Policies</h2><table><tr><th>ID</th><th>Slots</th><th>Window</th><th>Cap/day</th><th>Spacing</th></tr>${schedules}</table><details><summary>Rhythm anlegen / ändern</summary><form method=post action=/preview/rhythm><input type=hidden name=csrf value=${ctx.csrf}><input name=schedulePolicyId placeholder="standard-4x" required><input name=timeZone value="Europe/Vienna" required><input name=slots placeholder="slot-1@09:00,slot-2@11:00,slot-3@15:00,slot-4@17:00" required><input name=windowMinutes type=number value=30 min=0><input name=maxPerDay type=number value=4 min=1><input name=minimumSpacingMinutes type=number value=120 min=0><button>Auswirkungen prüfen</button></form></details></div><div class=card><h2>Operating Calendars</h2><table><tr><th>Kalender</th><th>Weekdays (1=Mo)</th><th>Date overrides</th><th>Status</th></tr>${calendars||"<tr><td colspan=4>Keine Kalender; Routes gelten täglich mit Default-Rhythmus.</td></tr>"}</table><details><summary>Kalender anlegen / ändern</summary><form method=post action=/preview/calendar><input type=hidden name=csrf value=${ctx.csrf}><input name=calendarId placeholder="weekday" required><input name=displayName placeholder="Mo–Fr" required><label><input type=checkbox name=enabled checked> enabled</label><p class=muted>Eine Zeile je Wochentag: <code>1|on|standard-4x</code>, <code>7|off</code>. Date override: <code>2026-12-24|on|holiday-2x|Christmas Eve</code>.</p><textarea name=weekdays rows=7></textarea><textarea name=dates rows=5></textarea><button>Auswirkungen prüfen</button></form></details></div>`);
}

function testLab(ctx:ProductControlPageContext):string{
  const accounts=new Map(ctx.runtime.accounts.map(item=>[item.accountId,item])),channels=new Map(ctx.runtime.channelReadiness.map(item=>[item.accountId,item]));
  const profiles=new Map(ctx.stored.config.postingProfiles.map(item=>[item.postingProfileId,item])),evidence=new Map(ctx.runtime.routeTests.map(item=>[item.routeId,item]));
  const surfaces=new Map((ctx.runtime.surfaceReadiness??[]).map(item=>[`${item.accountId}|${item.postingProfileId}`,item]));
  const cards=ctx.stored.config.routes.map(route=>{
    const matrix=buildRouteTestMatrix({route,profile:profiles.get(route.postingProfileId),account:accounts.get(route.accountId),channel:channels.get(route.accountId),...((s=>s?{surface:s}:{})(surfaces.get(`${route.accountId}|${route.postingProfileId}`))),evidence:evidence.get(route.routeId)});
    const caps=new Map((ctx.routeTests?.capabilities(route.routeId)??[]).map(item=>[item.testKey,item]));
    const cases=matrix.cases.map(test=>{
      if(test.testKey==="SECRET_LIVE")return`<div class=test-case><h4>${esc(test.label)}</h4><strong>${esc(test.status)}</strong><p>${esc(test.detail)}</p><small>Nur canonical Private-E2E + One-Shot Permit; kein normaler Run-Button.</small></div>`;
      const cap=caps.get(test.testKey as import("../../domain/route-test-ports.js").ExecutableRouteTestKey);
      const button=cap?.executable?`<form method=post action=/test-lab/run><input type=hidden name=csrf value=${ctx.csrf}><input type=hidden name=routeId value="${esc(route.routeId)}"><input type=hidden name=testKey value="${esc(test.testKey)}"><button>Run</button></form>`:`<small>${esc(cap?.reason??"Command adapter not configured on this host.")}</small>`;
      return`<div class=test-case><h4>${esc(test.label)}</h4><strong class="${test.status==="PASS"?"ok":test.status==="FAIL"?"bad":test.status==="BLOCKED"?"bad":"warn"}">${esc(test.status)}</strong><p>${esc(test.detail)}</p>${button}</div>`;
    }).join("");
    return`<div class="card program ${matrix.overall==="BLOCKED"?"bad":matrix.overall==="NEEDS_TEST"?"warn":""}"><h2>${esc(matrix.routeName)}</h2><p>${esc(matrix.platform)} · ${esc(matrix.account)} · ${esc(matrix.postingProfile)} · <strong>${esc(matrix.overall)}</strong></p><div class=test-grid>${cases}</div></div>`;
  }).join("");
  return shell("Test Lab","/test-lab",`<h1>Route Test Lab</h1><p class=muted>Planbar ≠ ausführbar. Tests sind release- und surface-scoped. SECRET_LIVE bleibt außerhalb dieses Command-Pfads.</p>${cards||'<div class=card>Keine Routes.</div>'}`);
}

function incidents(ctx:ProductControlPageContext):string{
  const cards=(ctx.runtime.incidents??[]).map(incident=>{const v=incidentView(incident);return`<div class="card ${v.severity==="CRITICAL"?"critical":"attention"}"><strong>${esc(v.title)}</strong><p>${esc(v.summary)}</p><p>${esc(v.impact)}</p><p>${v.allowedActions.map(a=>`<span class=pill>${esc(a)}</span>`).join(" ")}</p>${v.prohibitedAction?`<p class=bad>${esc(v.prohibitedAction)}</p>`:""}</div>`;}).join("");
  return shell("Incidents","/incidents",`<h1>Incidents</h1>${cards||'<div class="card ok">Keine offenen Incidents.</div>'}`);
}

function activity(ctx:ProductControlPageContext):string{
  const rows=projectActivity(ctx.runtime.auditEvents??[],200).map(item=>`<tr><td>${esc(new Date(item.occurredAt).toLocaleString("de-AT",{timeZone:"Europe/Vienna"}))}</td><td>${esc(item.kind)}</td><td>${esc(item.summary)}</td></tr>`).join("");
  return shell("Activity","/activity",`<h1>Activity</h1><div class=card><table><tr><th>Zeit</th><th>Event</th><th>Details</th></tr>${rows||"<tr><td colspan=3>Noch keine Audit-Events.</td></tr>"}</table></div>`);
}

export function renderProductControlPage(ctx:ProductControlPageContext):string{
  if(ctx.path==="/today")return today(ctx);
  if(ctx.path==="/workflows")return workflows(ctx);
  if(ctx.path==="/programs")return programs(ctx);
  if(ctx.path==="/content")return content(ctx);
  if(ctx.path==="/sources")return sources(ctx);
  if(ctx.path==="/channels")return channels(ctx);
  if(ctx.path==="/profiles")return profiles(ctx);
  if(ctx.path==="/rhythms")return rhythms(ctx);
  if(ctx.path==="/test-lab")return testLab(ctx);
  if(ctx.path==="/incidents")return incidents(ctx);
  if(ctx.path==="/activity")return activity(ctx);
  throw new Error(`Unknown product page: ${ctx.path}`);
}
