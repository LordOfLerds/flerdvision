import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { ControlCenterRuntimePort } from "../../domain/control-center-ports.js";
import type {
  CopyProfile,
  DistributionRoute,
  PostingProfile,
  SourceActivationCursor,
  SourceConnection,
  SourceLane
} from "../../domain/distribution.js";
import type { Platform } from "../../domain/model.js";
import { DistributionManagementService, type ConfigurationMutationPreview } from "../../application/distribution-management.js";
import { projectControlCenter } from "../../application/control-center-read-model.js";
import { DistributionConfigurationRevisionConflict } from "../distribution/json-config-store.js";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function parseBasicAuth(header: string | string[] | undefined): { username: string; password: string } | null {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const split = decoded.indexOf(":");
    return split < 0 ? null : { username: decoded.slice(0, split), password: decoded.slice(split + 1) };
  } catch { return null; }
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return await new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => resolve(new URLSearchParams(body)));
  });
}
function checkbox(form: URLSearchParams, key: string): boolean { return form.get(key) === "on" || form.get(key) === "true"; }
function required(form: URLSearchParams, key: string): string {
  const value = (form.get(key) ?? "").trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
function safeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(normalized)) throw new Error(`${label} contains unsupported characters`);
  return normalized;
}
function platform(value: string): Platform {
  if (value === "instagram" || value === "tiktok" || value === "youtube") return value;
  throw new Error(`Unsupported platform: ${value}`);
}
function iso(value: string, label: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid timestamp`);
  return new Date(time).toISOString();
}
function localTime(instant: string): string {
  return new Intl.DateTimeFormat("de-AT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Vienna" }).format(new Date(instant));
}

interface SignedCandidate {
  kind: "source" | "lane" | "cursor" | "posting-profile" | "copy-profile" | "route";
  payload: unknown;
  returnTo: string;
}

export interface ControlCenterHttpOptions {
  password: string;
  username?: string;
  host?: string;
  port?: number;
  now?: () => string;
  businessDate?: () => string;
}

export class ControlCenterHttpServer {
  private server: Server | undefined;
  private readonly csrf = randomBytes(24).toString("hex");
  private readonly signingSecret = randomBytes(32).toString("hex");
  private readonly now: () => string;
  private readonly businessDate: () => string;
  private readonly management: DistributionManagementService;

  constructor(
    private readonly configStore: DistributionConfigurationStorePort,
    private readonly runtime: ControlCenterRuntimePort,
    private readonly options: ControlCenterHttpOptions
  ) {
    if (!options.password) throw new Error("Control Center password is required");
    this.now = options.now ?? (() => new Date().toISOString());
    this.businessDate = options.businessDate ?? (() => new Date(this.now()).toISOString().slice(0, 10));
    this.management = new DistributionManagementService(configStore);
  }

  private authorized(req: IncomingMessage): boolean {
    const auth = parseBasicAuth(req.headers.authorization);
    return Boolean(auth && auth.username === (this.options.username ?? "flerdvision") && auth.password === this.options.password);
  }
  private deny(res: ServerResponse): void {
    res.statusCode = 401; res.setHeader("WWW-Authenticate", 'Basic realm="Flerdvision Control"'); res.end("Authentication required");
  }
  private redirect(res: ServerResponse, location: string): void { res.statusCode = 303; res.setHeader("Location", location); res.end(); }
  private shell(title: string, current: string, body: string): string {
    const nav = [["/today","Today"],["/sources","Sources"],["/routes","Routes"],["/profiles","Profiles"],["/schedule","Schedule"]]
      .map(([href,label]) => `<a class="${current===href?"active":""}" href="${href}">${label}</a>`).join("");
    return `<!doctype html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#15201e;background:#f6f8f7}.layout{display:grid;grid-template-columns:190px 1fr;min-height:100vh}nav{padding:24px 14px;background:#fff;border-right:1px solid #dfe6e3}nav h1{font-size:18px;margin:0 8px 22px}nav a{display:block;padding:9px 10px;margin:3px 0;border-radius:7px;color:#31413d;text-decoration:none}nav a.active{background:#e4f2ef;color:#075e58;font-weight:650}main{padding:28px;max-width:1280px}.card{background:#fff;border:1px solid #dfe6e3;border-radius:10px;padding:16px 18px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.kpi{font-size:28px;font-weight:700}.muted{color:#64736f}.ok{color:#267047}.warn{color:#8a6516}.bad{color:#a33d32}.action{color:#8a3f15}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #e6ecea;text-align:left;vertical-align:top}input,select,textarea,button{font:inherit;padding:7px 8px;margin:3px 2px;border:1px solid #bfcac7;border-radius:6px}button{cursor:pointer;background:#fff}button.primary{background:#0e6b64;color:white;border-color:#0e6b64}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.impact{border-left:4px solid #0e6b64;padding:12px 16px;background:#f1f8f6}.attention{border-left:4px solid #b57919}.critical{border-left-color:#a33d32}.pill{display:inline-block;padding:2px 7px;border-radius:999px;background:#edf1f0;font-size:12px}code{background:#edf1f0;padding:2px 4px;border-radius:4px}details{margin-top:8px}
</style></head><body><div class=layout><nav><h1>Flerdvision</h1>${nav}</nav><main>${body}</main></div></body></html>`;
  }

  private async projection(date = this.businessDate()) {
    const stored = this.configStore.load();
    const runtime = await this.runtime.snapshot(date);
    const postingProfiles = Object.fromEntries(stored.config.postingProfiles.map((p) => [p.postingProfileId, p]));
    return { stored, runtime, model: projectControlCenter({
      plan: runtime.plan,
      sources: stored.config.sources,
      lanes: stored.config.lanes,
      routes: stored.config.routes,
      postingProfiles,
      accounts: runtime.accounts,
      channelReadiness: runtime.channelReadiness,
      routeTests: runtime.routeTests,
      assets: runtime.assets
    }) };
  }

  private async todayPage(): Promise<string> {
    const { model } = await this.projection();
    const slots = model.today.slots.map((slot) => `<tr><td><strong>${escapeHtml(localTime(slot.scheduledFor))}</strong><br><small>${escapeHtml(slot.slotKey)}</small></td><td>${slot.deliveries.map((d) => `<div><code>${escapeHtml(d.assetId)}</code> → ${escapeHtml(d.platform)} · ${escapeHtml(d.format)} · <code>${escapeHtml(d.accountId)}</code> <span class=pill>${escapeHtml(d.requirement)}</span></div>`).join("")}</td></tr>`).join("");
    const attention = model.attention.map((a) => `<div class="card attention ${a.severity==="CRITICAL"?"critical":""}"><strong>${escapeHtml(a.severity)} · ${escapeHtml(a.title)}</strong><p>${escapeHtml(a.impact)}</p><a href="${escapeHtml(a.deepLink)}">Öffnen</a></div>`).join("");
    return this.shell("Today", "/today", `<h1>Today · ${escapeHtml(model.today.businessDate)}</h1><div class=grid><div class=card><div class=kpi>${model.today.totalDeliveries}</div><div class=muted>Deliveries</div></div><div class=card><div class="kpi ${model.today.gaps?"warn":"ok"}">${model.today.gaps}</div><div class=muted>Plan-Gaps</div></div><div class=card><div class=kpi>${model.today.backlog}</div><div class=muted>Backlog</div></div><div class=card><div class="kpi ${model.attention.some(a=>a.severity!=="INFO")?"warn":"ok"}">${model.attention.filter(a=>a.severity!=="INFO").length}</div><div class=muted>Needs attention</div></div></div><div class=card><h2>Slots</h2><table><tr><th>Zeit</th><th>Geplante Zustellungen</th></tr>${slots||"<tr><td colspan=2>Noch kein DailyPlan.</td></tr>"}</table></div><h2>Attention</h2>${attention||'<div class="card ok">Keine operativen Probleme im aktuellen Plan.</div>'}`);
  }

  private sourcesPage(): string {
    const stored = this.configStore.load(); const c=stored.config;
    const sourceRows=c.sources.map(s=>`<tr><td><strong>${escapeHtml(s.displayName)}</strong><br><code>${escapeHtml(s.connectionId)}</code></td><td>${escapeHtml(s.kind)}</td><td><code>${escapeHtml(s.rootRef)}</code></td><td>${escapeHtml(s.disposition.mode)}</td><td>${s.enabled?"✓":"paused"}</td></tr>`).join("");
    const cursorMap=new Map(c.activationCursors.map(x=>[x.laneId,x]));
    const laneRows=c.lanes.map(l=>{const cur=cursorMap.get(l.laneId);return `<tr><td><strong>${escapeHtml(l.displayName)}</strong><br><code>${escapeHtml(l.laneId)}</code></td><td><code>${escapeHtml(l.connectionId)}</code></td><td>${escapeHtml(l.folderPath)}</td><td>${escapeHtml(l.interpretation.kind)}</td><td>${cur?`${escapeHtml(cur.mode)}<br><small>${escapeHtml(cur.activatedAt)}</small>`:'<span class=bad>Activation cursor fehlt</span>'}</td></tr>`}).join("");
    const sourceOpts=c.sources.map(s=>`<option value="${escapeHtml(s.connectionId)}">${escapeHtml(s.displayName)}</option>`).join("");
    const laneOpts=c.lanes.map(l=>`<option value="${escapeHtml(l.laneId)}">${escapeHtml(l.displayName)}</option>`).join("");
    return this.shell("Sources","/sources",`<h1>Sources</h1><p class=muted>Quelle und Lane sind getrennt. Eine Lane bekommt eine explizite Activation-Grenze, bevor neue Dateien geplant werden.</p><div class=card><h2>Connections</h2><table><tr><th>Quelle</th><th>Typ</th><th>Root</th><th>Disposition</th><th>Status</th></tr>${sourceRows||"<tr><td colspan=5>Keine Quelle.</td></tr>"}</table><details><summary>Quelle hinzufügen / ändern</summary><form method=post action=/preview/source><input type=hidden name=csrf value=${this.csrf}><input name=connectionId placeholder="source id" required><input name=displayName placeholder="Name" required><select name=kind><option value=local_folder>Mounted folder</option><option value=google_drive>Google Drive API</option></select><input name=rootRef placeholder="root reference" required><select name=disposition><option>database_only</option><option>drive_metadata</option><option>sidecar</option><option>move_on_complete</option></select><label><input type=checkbox name=enabled checked> enabled</label><button>Auswirkungen prüfen</button></form></details></div><div class=card><h2>Lanes</h2><table><tr><th>Lane</th><th>Source</th><th>Ordner</th><th>Interpretation</th><th>Activation</th></tr>${laneRows||"<tr><td colspan=5>Keine Lane.</td></tr>"}</table><details><summary>Lane hinzufügen / ändern</summary><form method=post action=/preview/lane><input type=hidden name=csrf value=${this.csrf}><input name=laneId placeholder="lane id" required><input name=displayName placeholder="Name" required><select name=connectionId>${sourceOpts}</select><input name=folderRef placeholder="provider folder ref" required><input name=folderPath placeholder="sichtbarer Ordnerpfad" required><select name=interpretation><option value=flat>flat</option><option value=creator_week_day>creator/week/day</option><option value=metadata>metadata</option></select><label><input type=checkbox name=enabled checked> enabled</label><button>Auswirkungen prüfen</button></form></details><details><summary>Activation Cursor setzen</summary><form method=post action=/preview/cursor><input type=hidden name=csrf value=${this.csrf}><select name=laneId>${laneOpts}</select><select name=mode><option>NEW_ONLY</option><option>SINCE</option><option>IMPORT_BACKLOG</option><option>SELECTED</option></select><input name=since placeholder="SINCE timestamp (optional)"><textarea name=selected placeholder="SELECTED file ids, comma/newline separated"></textarea><button>Auswirkungen prüfen</button></form></details></div>`);
  }

  private async routesPage(): Promise<string> {
    const { stored, runtime, model }=await this.projection(); const c=stored.config;
    const rows=model.routes.map(r=>`<tr><td><strong>${escapeHtml(r.displayName)}</strong><br><code>${escapeHtml(r.routeId)}</code></td><td>${escapeHtml(r.sourceLane)}<br><small>${escapeHtml(r.sourcePath)}</small></td><td>${escapeHtml(r.platform)} · ${escapeHtml(r.channel)}</td><td>${escapeHtml(r.postingProfile)}</td><td>${escapeHtml(r.requirement)}</td><td class=${r.readiness==="READY"?"ok":r.readiness==="BLOCKED"?"bad":"warn"}>${escapeHtml(r.readiness)}</td></tr>`).join("");
    const lanes=c.lanes.map(l=>`<option value="${escapeHtml(l.laneId)}">${escapeHtml(l.displayName)}</option>`).join("");
    const accounts=runtime.accounts.map(a=>`<option value="${escapeHtml(a.accountId)}" data-platform="${escapeHtml(a.platform)}">${escapeHtml(a.platform)} · @${escapeHtml(a.expectedHandle)}</option>`).join("");
    const pp=c.postingProfiles.map(p=>`<option value="${escapeHtml(p.postingProfileId)}">${escapeHtml(p.platform)} · ${escapeHtml(p.displayName)}</option>`).join("");
    const cp=c.copyProfiles.map(p=>`<option value="${escapeHtml(p.copyProfileId)}">${escapeHtml(p.displayName)} · ${escapeHtml(p.versionId)}</option>`).join("");
    const sp=Object.keys(stored.schedulePolicies).map(id=>`<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
    return this.shell("Routes","/routes",`<h1>Routes</h1><p class=muted>Eine Lane darf mehrere Channels speisen; ein Channel darf mehrere Lanes erhalten. Die Route definiert Ziel, Posting-Verhalten, Copy, Schedule und Required/Optional.</p><div class=card><table><tr><th>Route</th><th>Source Lane</th><th>Channel</th><th>Profile</th><th>Requirement</th><th>Readiness</th></tr>${rows||"<tr><td colspan=6>Keine Route.</td></tr>"}</table></div><div class=card><h2>Route hinzufügen / ändern</h2><form method=post action=/preview/route><input type=hidden name=csrf value=${this.csrf}><input name=routeId placeholder="route id" required><input name=displayName placeholder="Name" required><select name=laneId>${lanes}</select><select name=accountId>${accounts}</select><select name=postingProfileId>${pp}</select><select name=copyProfileId>${cp}</select><select name=schedulePolicyId>${sp}</select><select name=requirement><option>REQUIRED</option><option>OPTIONAL</option></select><label><input type=checkbox name=enabled checked> enabled</label><button>Auswirkungen prüfen</button></form></div>`);
  }

  private profilesPage(): string {
    const stored=this.configStore.load(); const c=stored.config;
    const profiles=c.postingProfiles.map(p=>`<tr><td><strong>${escapeHtml(p.displayName)}</strong><br><code>${escapeHtml(p.postingProfileId)}</code></td><td>${escapeHtml(p.platform)}</td><td>${escapeHtml(p.format)}</td><td>${"visibility" in p?escapeHtml(String(p.visibility)):"—"}</td><td>${p.enabled?"✓":"paused"}</td></tr>`).join("");
    const copies=c.copyProfiles.map(p=>`<tr><td><strong>${escapeHtml(p.displayName)}</strong><br><code>${escapeHtml(p.copyProfileId)}</code></td><td>${escapeHtml(p.versionId)}</td><td>${escapeHtml(p.strategy)}</td><td>${p.enabled?"✓":"paused"}</td></tr>`).join("");
    return this.shell("Profiles","/profiles",`<h1>Profiles</h1><p class=muted>PostingProfile beschreibt Plattformverhalten; CopyProfile beschreibt Textstrategie und Version. Routes referenzieren beides.</p><div class=card><h2>Posting Profiles</h2><table><tr><th>Profil</th><th>Plattform</th><th>Format</th><th>Visibility</th><th>Status</th></tr>${profiles||"<tr><td colspan=5>Keine Posting Profiles.</td></tr>"}</table><details><summary>Posting Profile hinzufügen / ändern</summary><form method=post action=/preview/posting-profile><input type=hidden name=csrf value=${this.csrf}><input name=postingProfileId placeholder="profile id" required><input name=displayName placeholder="Name" required><select name=platform><option>instagram</option><option>tiktok</option><option>youtube</option></select><select name=format><option>reel</option><option>trial_reel</option><option>story</option><option>tiktok</option><option>short</option></select><select name=visibility><option value=only_you>only_you</option><option value=friends>friends</option><option value=followers>followers</option><option value=everyone>everyone</option><option value=private>private</option><option value=unlisted>unlisted</option><option value=public>public</option></select><label><input type=checkbox name=comments checked> comments</label><label><input type=checkbox name=shareToFeed checked> share to feed</label><label><input type=checkbox name=crosspostFacebook> Facebook crosspost</label><label><input type=checkbox name=duet checked> duet</label><label><input type=checkbox name=stitch checked> stitch</label><label><input type=checkbox name=enabled checked> enabled</label><button>Auswirkungen prüfen</button></form></details></div><div class=card><h2>Copy Profiles</h2><table><tr><th>Profil</th><th>Version</th><th>Strategie</th><th>Status</th></tr>${copies||"<tr><td colspan=4>Keine Copy Profiles.</td></tr>"}</table><details><summary>Copy Profile hinzufügen / ändern</summary><form method=post action=/preview/copy-profile><input type=hidden name=csrf value=${this.csrf}><input name=copyProfileId placeholder="copy id" required><input name=displayName placeholder="Name" required><input name=versionId placeholder="version id" required><select name=strategy><option>static</option><option>template</option><option>ai_assisted</option></select><label><input type=checkbox name=enabled checked> enabled</label><button>Auswirkungen prüfen</button></form></details></div>`);
  }

  private schedulePage(): string {
    const stored=this.configStore.load();
    const rows=Object.entries(stored.schedulePolicies).map(([id,p])=>`<tr><td><code>${escapeHtml(id)}</code></td><td>${escapeHtml(p.timeZone)}</td><td>${p.slots.map(s=>escapeHtml(s.localTime)).join(", ")}</td><td>±${p.windowMinutes} min</td><td>${p.maxPerAccountPerBusinessDate}</td></tr>`).join("");
    const pol=stored.planningPolicy;
    return this.shell("Schedule","/schedule",`<h1>Schedule</h1><div class=card><table><tr><th>Policy</th><th>Timezone</th><th>Slots</th><th>Window</th><th>Max/account/day</th></tr>${rows}</table></div><div class=card><h2>Planning behaviour</h2><p>Content order: <code>${escapeHtml(pol.contentOrder)}</code></p><p>Late arrival: <code>${escapeHtml(pol.lateArrival)}</code></p><p>Overflow: <code>${escapeHtml(pol.overflow)}</code></p><p class=muted>Bearbeitung folgt als eigener revisionssicherer Slice; diese Seite zeigt bereits die tatsächlich vom Planner verwendete Policy.</p></div>`);
  }

  private sign(candidate: SignedCandidate): { payload: string; signature: string } {
    const payload=Buffer.from(JSON.stringify(candidate),"utf8").toString("base64url");
    return { payload, signature:createHash("sha256").update(`${this.signingSecret}|${payload}|${this.signingSecret}`).digest("hex") };
  }
  private verify(payload: string, signature: string): SignedCandidate {
    const expected=createHash("sha256").update(`${this.signingSecret}|${payload}|${this.signingSecret}`).digest("hex");
    if (createHash("sha256").update(signature).digest("hex") !== createHash("sha256").update(expected).digest("hex")) throw new Error("Change preview signature is invalid");
    return JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as SignedCandidate;
  }
  private previewPage(candidate: SignedCandidate, preview: ConfigurationMutationPreview): string {
    const signed=this.sign(candidate); const i=preview.impact;
    const routes=i.affectedRouteIds.length?i.affectedRouteIds.map(id=>`<code>${escapeHtml(id)}</code>`).join(" "):"keine bestehenden Routes";
    return this.shell("Auswirkungsprüfung","",`<h1>Auswirkungsprüfung</h1><div class="card impact"><h2>${escapeHtml(i.changeKind)}</h2><p>${escapeHtml(i.operatorSummary)}</p><p><strong>Betroffene Routes:</strong> ${routes}</p><ul><li>Future DailyPlans neu erzeugen: <strong>${i.invalidateFutureDailyPlans?"JA":"nein"}</strong></li><li>Route-Test erneut erforderlich: <strong>${i.requireRouteRetest?"JA":"nein"}</strong></li><li>Neue Activation-Grenze erforderlich: <strong>${i.requireActivationCursor?"JA":"nein"}</strong></li><li>Verifizierte Publikationen bleiben unverändert: <strong>JA</strong></li><li>Audit-Historie bleibt unverändert: <strong>JA</strong></li></ul></div><form method=post action=/apply><input type=hidden name=csrf value=${this.csrf}><input type=hidden name=payload value="${escapeHtml(signed.payload)}"><input type=hidden name=signature value="${escapeHtml(signed.signature)}"><input type=hidden name=revision value="${preview.currentRevision}"><button class=primary>Änderung bestätigen</button> <a href="${escapeHtml(candidate.returnTo)}">Abbrechen</a></form>`);
  }

  private sourceFrom(form: URLSearchParams): SourceConnection {
    const disposition=required(form,"disposition");
    if (!["database_only","drive_metadata","sidecar","move_on_complete"].includes(disposition)) throw new Error("Unsupported source disposition");
    return { connectionId:safeId(required(form,"connectionId"),"connectionId"),displayName:required(form,"displayName"),kind:required(form,"kind") === "google_drive" ? "google_drive" : "local_folder",rootRef:required(form,"rootRef"),enabled:checkbox(form,"enabled"),disposition:{mode:disposition as SourceConnection["disposition"]["mode"],leavePartialUntouched:true,leaveBlockedUntouched:true} };
  }
  private laneFrom(form: URLSearchParams): SourceLane {
    const kind=required(form,"interpretation"); if(!["flat","creator_week_day","metadata"].includes(kind)) throw new Error("Unsupported lane interpretation");
    return { laneId:safeId(required(form,"laneId"),"laneId"),connectionId:safeId(required(form,"connectionId"),"connectionId"),displayName:required(form,"displayName"),folderRef:required(form,"folderRef"),folderPath:required(form,"folderPath"),interpretation:{kind:kind as SourceLane["interpretation"]["kind"]},enabled:checkbox(form,"enabled") } as SourceLane;
  }
  private cursorFrom(form: URLSearchParams): SourceActivationCursor {
    const mode=required(form,"mode"); if(!["NEW_ONLY","SINCE","IMPORT_BACKLOG","SELECTED"].includes(mode)) throw new Error("Unsupported activation mode");
    const cursor: SourceActivationCursor={laneId:safeId(required(form,"laneId"),"laneId"),mode:mode as SourceActivationCursor["mode"],activatedAt:this.now()};
    const since=(form.get("since")??"").trim(); if(mode==="SINCE"){ if(!since) throw new Error("SINCE mode requires a timestamp"); Object.assign(cursor,{since:iso(since,"since")}); }
    if(mode==="SELECTED"){const ids=(form.get("selected")??"").split(/[\n,]+/).map(v=>v.trim()).filter(Boolean);if(ids.length===0)throw new Error("SELECTED mode requires at least one file id");Object.assign(cursor,{selectedExternalObjectIds:ids});}
    return cursor;
  }
  private postingProfileFrom(form: URLSearchParams): PostingProfile {
    const id=safeId(required(form,"postingProfileId"),"postingProfileId"), displayName=required(form,"displayName"), p=platform(required(form,"platform")), format=required(form,"format"), enabled=checkbox(form,"enabled"), commentsEnabled=checkbox(form,"comments");
    if(p==="instagram"){if(!["reel","trial_reel","story"].includes(format))throw new Error("Instagram profile requires reel, trial_reel or story");return{postingProfileId:id,displayName,platform:p,format:format as "reel"|"trial_reel"|"story",commentsEnabled,shareToFeed:checkbox(form,"shareToFeed"),crosspostFacebook:checkbox(form,"crosspostFacebook"),enabled};}
    if(p==="tiktok"){if(format!=="tiktok")throw new Error("TikTok profile requires tiktok format");const v=required(form,"visibility");if(!["only_you","friends","followers","everyone"].includes(v))throw new Error("Invalid TikTok visibility");return{postingProfileId:id,displayName,platform:p,format:"tiktok",visibility:v as "only_you"|"friends"|"followers"|"everyone",commentsEnabled,duetEnabled:checkbox(form,"duet"),stitchEnabled:checkbox(form,"stitch"),enabled};}
    if(format!=="short")throw new Error("YouTube profile requires short format");const v=required(form,"visibility");if(!["private","unlisted","public"].includes(v))throw new Error("Invalid YouTube visibility");return{postingProfileId:id,displayName,platform:p,format:"short",visibility:v as "private"|"unlisted"|"public",commentsEnabled,enabled};
  }
  private copyProfileFrom(form: URLSearchParams): CopyProfile { const strategy=required(form,"strategy"); if(!["static","template","ai_assisted"].includes(strategy))throw new Error("Invalid copy strategy"); return {copyProfileId:safeId(required(form,"copyProfileId"),"copyProfileId"),displayName:required(form,"displayName"),versionId:safeId(required(form,"versionId"),"versionId"),strategy:strategy as CopyProfile["strategy"],enabled:checkbox(form,"enabled")}; }
  private async routeFrom(form: URLSearchParams): Promise<DistributionRoute> {
    const snapshot=await this.runtime.snapshot(this.businessDate()); const accountId=safeId(required(form,"accountId"),"accountId"); const account=snapshot.accounts.find(a=>a.accountId===accountId); if(!account)throw new Error(`Unknown social account: ${accountId}`);
    const stored=this.configStore.load(); const postingProfileId=safeId(required(form,"postingProfileId"),"postingProfileId"); const posting=stored.config.postingProfiles.find(p=>p.postingProfileId===postingProfileId); if(!posting)throw new Error(`Unknown posting profile: ${postingProfileId}`); if(account.platform!==posting.platform)throw new Error("Selected channel and posting profile use different platforms");
    return {routeId:safeId(required(form,"routeId"),"routeId"),displayName:required(form,"displayName"),laneId:safeId(required(form,"laneId"),"laneId"),accountId,platform:account.platform,postingProfileId,copyProfileId:safeId(required(form,"copyProfileId"),"copyProfileId"),schedulePolicyId:safeId(required(form,"schedulePolicyId"),"schedulePolicyId"),requirement:required(form,"requirement")==="OPTIONAL"?"OPTIONAL":"REQUIRED",enabled:checkbox(form,"enabled")};
  }

  private async preview(kind: SignedCandidate["kind"], form: URLSearchParams): Promise<string> {
    if(kind==="source"){const value=this.sourceFrom(form);return this.previewPage({kind,payload:value,returnTo:"/sources"},this.management.previewSource(value));}
    if(kind==="lane"){const value=this.laneFrom(form);return this.previewPage({kind,payload:value,returnTo:"/sources"},this.management.previewLane(value));}
    if(kind==="cursor"){const value=this.cursorFrom(form);return this.previewPage({kind,payload:value,returnTo:"/sources"},this.management.previewActivationCursor(value));}
    if(kind==="posting-profile"){const value=this.postingProfileFrom(form);return this.previewPage({kind,payload:value,returnTo:"/profiles"},this.management.previewPostingProfile(value));}
    if(kind==="copy-profile"){const value=this.copyProfileFrom(form);return this.previewPage({kind,payload:value,returnTo:"/profiles"},this.management.previewCopyProfile(value));}
    const value=await this.routeFrom(form);return this.previewPage({kind,payload:value,returnTo:"/routes"},this.management.previewRoute(value));
  }
  private apply(candidate: SignedCandidate, revision: number): string {
    const now=this.now();
    if(candidate.kind==="source")this.management.saveSource(candidate.payload as SourceConnection,revision,now);
    else if(candidate.kind==="lane")this.management.saveLane(candidate.payload as SourceLane,revision,now);
    else if(candidate.kind==="cursor")this.management.saveActivationCursor(candidate.payload as SourceActivationCursor,revision,now);
    else if(candidate.kind==="posting-profile")this.management.savePostingProfile(candidate.payload as PostingProfile,revision,now);
    else if(candidate.kind==="copy-profile")this.management.saveCopyProfile(candidate.payload as CopyProfile,revision,now);
    else this.management.saveRoute(candidate.payload as DistributionRoute,revision,now);
    return candidate.returnTo;
  }

  private async handle(req: IncomingMessage,res:ServerResponse):Promise<void>{
    if(!this.authorized(req)){this.deny(res);return;} const method=req.method??"GET"; const url=new URL(req.url??"/","http://127.0.0.1"); const path=url.pathname;
    try{
      if(method==="GET"){
        if(path==="/"){this.redirect(res,"/today");return;}
        let html:string;
        if(path==="/today")html=await this.todayPage(); else if(path==="/sources")html=this.sourcesPage(); else if(path==="/routes")html=await this.routesPage(); else if(path==="/profiles")html=this.profilesPage(); else if(path==="/schedule")html=this.schedulePage(); else {res.statusCode=404;res.end("Not found");return;}
        res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;
      }
      if(method!=="POST"){res.statusCode=404;res.end("Not found");return;}
      const form=await readForm(req); if(form.get("csrf")!==this.csrf){res.statusCode=403;res.end("Invalid CSRF token");return;}
      const pm=path.match(/^\/preview\/(source|lane|cursor|posting-profile|copy-profile|route)$/); if(pm){const html=await this.preview(pm[1] as SignedCandidate["kind"],form);res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;}
      if(path==="/apply"){
        const payload=required(form,"payload"),signature=required(form,"signature"),revision=Number(required(form,"revision")); if(!Number.isInteger(revision)||revision<0)throw new Error("Invalid configuration revision"); const candidate=this.verify(payload,signature); const destination=this.apply(candidate,revision); this.redirect(res,destination);return;
      }
      res.statusCode=404;res.end("Not found");
    }catch(error){res.statusCode=error instanceof DistributionConfigurationRevisionConflict?409:409;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end(error instanceof Error?error.message:String(error));}
  }

  async start():Promise<{host:string;port:number}>{if(this.server)throw new Error("Control Center already started");const host=this.options.host??"127.0.0.1",port=this.options.port??0;this.server=createServer((req,res)=>{void this.handle(req,res)});await new Promise<void>(resolve=>this.server!.listen(port,host,resolve));const address=this.server.address();if(!address||typeof address==="string")throw new Error("Control Center did not expose TCP address");return{host,port:address.port};}
  async stop():Promise<void>{if(!this.server)return;const server=this.server;this.server=undefined;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
