import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { WorkspaceRegistryPort } from "../../domain/workspace-ports.js";
import type { Platform } from "../../domain/model.js";
import type { ChannelDiscoveryPort } from "../../domain/channel-discovery-ports.js";
import type { ChannelDiscoveryResult } from "../../domain/channel-discovery.js";
import type { SourceFolderBrowserPort, SourceFolderSelectionResolverPort } from "../../domain/source-folder-ports.js";
import type { SourceFolderPreview } from "../../domain/source-folder.js";
import type { OperatorBrowserSession } from "../../application/browser-bootstrap.js";
import { WorkspaceService, workspaceRuntimeLayout } from "../../application/workspaces.js";
import { BrowserBootstrapService } from "../../application/browser-bootstrap.js";
import { deriveProfileKey, selectDiscoveredChannel } from "../../domain/channel-discovery.js";
import { SetupChannelRegistrationService } from "../../application/setup-channel-registration.js";
import { loginProfileKey, seedChannelProfile } from "../../application/login-profile.js";
import { SetupDistributionOnboardingService, type SetupSourceProvider } from "../../application/setup-distribution-onboarding.js";
import { JsonDistributionConfigurationStore } from "../distribution/json-config-store.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../browser/profile-lock.js";
import { ChromiumCdpRuntimeAdapter } from "../browser/chromium-cdp.js";
import { FileDriveCredentialStore, type StoredDriveCredential } from "../ingress/google-drive/drive-credentials.js";
import { WorkspaceSourceActivationCommands } from "../runtime/workspace-source-activation.js";

interface SelectedFolder { folderId:string;folderPath:string;preview?:SourceFolderPreview;selectedAt:string; }
interface RetainedOperatorSession { session:OperatorBrowserSession;store:SqliteControlPlaneStore;profileKey:string;platform:Platform; }
interface PendingDiscovery { platform:Platform;result:ChannelDiscoveryResult; }

export interface ProductSetupSourceAdapter {
  browser:SourceFolderBrowserPort;
  resolver:SourceFolderSelectionResolverPort;
  provider:SetupSourceProvider;
}

export interface ProductSetupSourceAdapterFactory {
  forWorkspace(workspaceId:string):ProductSetupSourceAdapter;
}

export interface ProductSetupDriveOAuthPort {
  begin(workspaceId:string):{state:string;codeVerifier:string;authorizationUrl:string};
  complete(workspaceId:string,code:string,codeVerifier:string):Promise<StoredDriveCredential>;
}

export interface ProductSetupHttpOptions {
  runtimeRoot:string;
  password:string;
  username?:string;
  host?:string;
  port?:number;
  chromiumExecutablePath:string;
  sourceFactory?:ProductSetupSourceAdapterFactory;
  driveOAuth?:ProductSetupDriveOAuthPort;
  channelDiscovery?:ChannelDiscoveryPort;
  headlessLogin?:boolean;
  controlCenterBaseUrl?:string;
}

function esc(value:string):string{return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function basic(header:string|string[]|undefined):{username:string;password:string}|null{if(typeof header!=="string"||!header.startsWith("Basic "))return null;try{const value=Buffer.from(header.slice(6),"base64").toString("utf8"),i=value.indexOf(":");return i<0?null:{username:value.slice(0,i),password:value.slice(i+1)};}catch{return null;}}
async function readForm(req:IncomingMessage):Promise<URLSearchParams>{return await new Promise(resolvePromise=>{let body="";req.on("data",chunk=>{body+=chunk.toString();});req.on("end",()=>resolvePromise(new URLSearchParams(body)));});}
function platform(value:string):Platform{if(value==="instagram"||value==="tiktok"||value==="youtube")return value;throw new Error(`Unsupported platform: ${value}`);}
function bootstrapUrl(value:Platform):string{return value==="instagram"?"https://www.instagram.com/":value==="tiktok"?"https://www.tiktok.com/":"https://studio.youtube.com/";}

export class ProductSetupHttpServer {
  private server:Server|undefined;
  private readonly csrf=createHash("sha256").update(`${Date.now()}|${Math.random()}`).digest("hex");
  private readonly selections=new Map<string,SelectedFolder>();
  private readonly sessions=new Map<string,RetainedOperatorSession>();
  private readonly discoveries=new Map<string,PendingDiscovery>();
  private readonly pendingAuth=new Map<string,{state:string;codeVerifier:string}>();

  constructor(private readonly registry:WorkspaceRegistryPort,private readonly options:ProductSetupHttpOptions){if(!options.password)throw new Error("Product setup password is required");}
  private layout(workspaceId:string){return workspaceRuntimeLayout(this.options.runtimeRoot,workspaceId);}
  private credentials(workspaceId:string){return new FileDriveCredentialStore(this.layout(workspaceId).configDir);}
  private actor(){return{type:"operator" as const,id:this.options.username??"flerdvision"};}
  private authorized(req:IncomingMessage):boolean{const auth=basic(req.headers.authorization);return Boolean(auth&&auth.username===(this.options.username??"flerdvision")&&auth.password===this.options.password);}
  private deny(res:ServerResponse):void{res.statusCode=401;res.setHeader("WWW-Authenticate",'Basic realm="Flerdvision Setup"');res.end("Authentication required");}
  private redirect(res:ServerResponse,location:string):void{res.statusCode=303;res.setHeader("Location",location);res.end();}
  private shell(title:string,body:string):string{return`<!doctype html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#17221f;line-height:1.5}.card{border:1px solid #dce4e1;border-radius:10px;padding:16px 18px;margin:14px 0}.ok{color:#24704a}.warn{color:#916719}.bad{color:#a23e34}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}input,select,button{font:inherit;padding:7px 8px;margin:3px;border:1px solid #bcc8c4;border-radius:6px}button{cursor:pointer}.primary{background:#0e6b64;color:#fff;border-color:#0e6b64}code{background:#eef2f0;padding:2px 4px;border-radius:4px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #e5ebe8}.proof{border-left:4px solid #27704b;background:#f1f7f4;padding:10px 14px}.gate{border-left:4px solid #a23e34;background:#fbf1ef;padding:10px 14px}</style></head><body>${body}</body></html>`;}

  private sourceConnected(workspaceId:string):boolean{
    if(!this.options.sourceFactory)return false;
    try{this.options.sourceFactory.forWorkspace(workspaceId);return true;}catch{return this.credentials(workspaceId).status().connected;}
  }

  private facts(workspaceId:string){
    const layout=this.layout(workspaceId),control=new SqliteControlPlaneStore(layout.databasePath),config=new JsonDistributionConfigurationStore(resolve(layout.configDir,"distribution.json"));
    try{return{channels:control.listSocialAccounts().map(item=>item.account),identities:control.listBrowserIdentities().map(item=>item.identity),stored:config.load()};}
    finally{control.close();}
  }

  private home():string{
    const rows=this.registry.list().map(item=>`<tr><td><a href="/workspaces/${encodeURIComponent(item.workspaceId)}">${esc(item.displayName)}</a></td><td><code>${esc(item.workspaceId)}</code></td><td>${esc(item.status)}</td></tr>`).join("");
    return this.shell("Flerdvision Setup",`<h1>Flerdvision Setup</h1><p>Onboarding legt <strong>Sources/Lanes</strong> und <strong>Channels</strong> unabhängig an. Die Verknüpfung zu PostingProfile/Rhythmus passiert anschließend in <strong>Programs</strong>.</p><table><tr><th>Workspace</th><th>ID</th><th>Status</th></tr>${rows||"<tr><td colspan=3>Noch kein Workspace.</td></tr>"}</table><div class=card><h2>Workspace anlegen</h2><form method=post action=/workspaces><input type=hidden name=csrf value=${this.csrf}><input name=workspaceId placeholder="workspace id" required><input name=displayName placeholder="Name" required><input name=timezone value="Europe/Vienna" required><button class=primary>Anlegen</button></form></div>`);
  }

  private workspacePage(workspaceId:string):string{
    const workspace=this.registry.get(workspaceId);if(!workspace)return this.shell("Nicht gefunden","<h1>Workspace nicht gefunden</h1>");
    const facts=this.facts(workspaceId),selected=this.selections.get(workspaceId),sourceConnected=this.sourceConnected(workspaceId),open=this.sessions.get(`${workspaceId}:login`),pending=this.discoveries.get(workspaceId);
    const lanes=facts.stored.config.lanes.map(lane=>`<tr><td>${esc(lane.displayName)}</td><td>${esc(lane.folderPath)}</td><td>${lane.creatorId?`<code>${esc(lane.creatorId)}</code>`:"—"}</td><td>${esc(facts.stored.config.activationCursors.find(c=>c.laneId===lane.laneId)?.mode??"MISSING")}</td></tr>`).join("");
    const channels=facts.channels.map(account=>{const identity=facts.identities.find(item=>item.accountId===account.accountId);return`<tr><td>${esc(account.platform)}</td><td>@${esc(account.expectedHandle)}</td><td><code>${esc(account.accountId)}</code></td><td><code>${esc(identity?.profileKey??"missing")}</code></td></tr>`;}).join("");
    const sourceCard=sourceConnected
      ?`<div class=proof>Source-Zugang verfügbar. ${this.credentials(workspaceId).status().connected?"Google Drive Credential dieses Workspace verbunden.":"Mounted/local Source aktiv."}</div><p><a href="/workspaces/${encodeURIComponent(workspaceId)}/browse?folderId=root">Source durchsuchen</a></p>`
      :`<div class=gate>Noch keine Source verfügbar.</div>${this.options.driveOAuth?`<form method=post action="/workspaces/${workspaceId}/drive/connect"><input type=hidden name=csrf value=${this.csrf}><button>Google Drive verbinden</button></form>`:"<p>Starte Setup mit einem mounted <code>--source-root</code> oder konfiguriere Google OAuth.</p>"}`;
    const selectedCard=selected?`<div class=proof><strong>${esc(selected.folderPath)}</strong>${selected.preview?` · ${selected.preview.videoCount} Videos`:""}</div><form method=post action="/workspaces/${workspaceId}/lane"><input type=hidden name=csrf value=${this.csrf}><label>Activation <select name=activationMode><option value=NEW_ONLY>Nur neue Dateien ab jetzt</option><option value=IMPORT_BACKLOG>Bestehende Dateien importieren</option></select></label><label><input type=checkbox name=interpretSubstructure> creator/week/day auswerten</label><button class=primary>Als Source Lane speichern</button></form>`:"<p class=warn>Wähle zuerst einen Folder.</p>";
    const login= pending
      ?`<div class=proof>${pending.result.channels.length} Channel(s) aus der ${esc(pending.platform)}-Session gelesen.</div><form method=post action="/workspaces/${workspaceId}/channel"><input type=hidden name=csrf value=${this.csrf}>${pending.result.channels.map(c=>`<label style="display:block"><input type=radio name=channelKey value="${esc(c.channelKey)}" required> ${esc(c.displayName)} · <code>${esc(c.handle)}</code></label>`).join("")}<button class=primary>Channel übernehmen</button></form>`
      :open
        ?`<p>Login-Browser für ${esc(open.platform)} offen. Login/2FA dort selbst durchführen.</p><form method=post action="/workspaces/${workspaceId}/discover"><input type=hidden name=csrf value=${this.csrf}><button>Session auslesen</button></form><form method=post action="/workspaces/${workspaceId}/browser/close"><input type=hidden name=csrf value=${this.csrf}><button>Browser schließen</button></form>`
        :`<form method=post action="/workspaces/${workspaceId}/browser/open"><input type=hidden name=csrf value=${this.csrf}><select name=platform><option>instagram</option><option>tiktok</option><option>youtube</option></select><input name=slot value=primary><button>Login-Browser öffnen</button></form>`;
    const ready=facts.stored.config.lanes.length>0&&facts.channels.length>0;
    const base=this.options.controlCenterBaseUrl?.replace(/\/$/,"")??"http://127.0.0.1:8790";
    return this.shell(workspace.displayName,`<p><a href=/>&larr; Workspaces</a></p><h1>${esc(workspace.displayName)}</h1><p><code>${esc(workspaceId)}</code></p><div class=grid><div class=card><h2>1 · Source Lane</h2>${sourceCard}${selectedCard}<h3>Persistente Lanes</h3><table><tr><th>Lane</th><th>Folder</th><th>Creator</th><th>Activation</th></tr>${lanes||"<tr><td colspan=4>Noch keine Lane.</td></tr>"}</table></div><div class=card><h2>2 · Channels</h2>${login}<h3>Registrierte Channels</h3><table><tr><th>Platform</th><th>Handle</th><th>ID</th><th>Profil</th></tr>${channels||"<tr><td colspan=4>Noch kein Channel.</td></tr>"}</table></div></div><div class=card><h2>3 · Programs</h2>${ready?`<div class=proof>Source Lane + Channel vorhanden. Onboarding ist fertig; jetzt Targets, PostingProfile und Rhythmus im Control Center verbinden.</div><p><a href="${esc(base)}/programs">Programs öffnen</a></p>`:`<div class=gate>Mindestens eine Source Lane und ein Channel sind nötig. Eine direkte Folder↔Account-Bindung gibt es nicht mehr.</div>`}</div>`);
  }

  private async browsePage(workspaceId:string,folderId:string):Promise<string>{
    const adapter=this.options.sourceFactory?.forWorkspace(workspaceId);if(!adapter)throw new Error("No source adapter configured for this workspace");
    const listing=await adapter.browser.listFolder(folderId),crumbs=listing.path.map((c,i)=>i===listing.path.length-1?`<strong>${esc(c.name)}</strong>`:`<a href="/workspaces/${workspaceId}/browse?folderId=${encodeURIComponent(c.id)}">${esc(c.name)}</a>`).join(" / ");
    const rows=listing.entries.map(entry=>entry.kind==="folder"?`<tr><td>📁 <a href="/workspaces/${workspaceId}/browse?folderId=${encodeURIComponent(entry.id)}">${esc(entry.name)}</a></td><td>Ordner</td></tr>`:`<tr><td>📄 ${esc(entry.name)}</td><td>${esc(entry.mimeType??"Datei")}</td></tr>`).join("");
    const pick=listing.folderId!=="root"?`<form method=post action="/workspaces/${workspaceId}/folder"><input type=hidden name=csrf value=${this.csrf}><input type=hidden name=folderId value="${esc(listing.folderId)}"><input type=hidden name=folderPath value="${esc(listing.path.map(c=>c.name).join(" / "))}"><button class=primary>Diesen Folder wählen</button></form>`:"<p>Wähle einen Unterordner als Lane.</p>";
    return this.shell(listing.folderName,`<p><a href="/workspaces/${workspaceId}">&larr; Setup</a></p><h1>${esc(listing.folderName)}</h1><p>${crumbs}</p><table><tr><th>Name</th><th>Typ</th></tr>${rows||"<tr><td colspan=2>Leer</td></tr>"}</table>${pick}`);
  }

  private async openLogin(workspaceId:string,platformName:Platform,slot:string):Promise<void>{
    if(this.sessions.has(`${workspaceId}:login`))throw new Error("Login browser already open");
    const layout=this.layout(workspaceId),profileKey=loginProfileKey(platformName,slot),store=new SqliteControlPlaneStore(layout.databasePath);
    const resolver=new BrowserProfileDirectoryResolver(layout.profilesDir),locks=new DurableBrowserProfileLockAdapter(store,new FileBrowserProfileLockAdapter(resolver)),runtime=new ChromiumCdpRuntimeAdapter({profilesRoot:layout.profilesDir,executablePath:this.options.chromiumExecutablePath});
    const provisional={identityId:`setup:${profileKey}`,accountId:`setup:${profileKey}`,platform:platformName,profileKey,expectedHandle:"unknown",enabled:true};
    const session=await new BrowserBootstrapService(store,runtime,locks).openProvisional({identity:provisional,ownerId:this.actor().id,bootstrapUrl:bootstrapUrl(platformName),now:new Date().toISOString(),headless:this.options.headlessLogin??false});
    this.sessions.set(`${workspaceId}:login`,{session,store,profileKey,platform:platformName});
  }
  private async closeLogin(workspaceId:string):Promise<void>{const item=this.sessions.get(`${workspaceId}:login`);if(!item)return;this.sessions.delete(`${workspaceId}:login`);try{await item.session.close();}finally{item.store.close();}}
  private async discover(workspaceId:string):Promise<void>{const retained=this.sessions.get(`${workspaceId}:login`);if(!retained)throw new Error("No login browser open");if(!this.options.channelDiscovery)throw new Error("Channel discovery is not calibrated/configured; nothing will be guessed or typed.");const result=await this.options.channelDiscovery.discover(retained.session.page,retained.platform,new Date().toISOString());this.discoveries.set(workspaceId,{platform:retained.platform,result});}
  private async confirmChannel(workspaceId:string,channelKey:string):Promise<void>{
    const pending=this.discoveries.get(workspaceId);if(!pending)throw new Error("No discovered session");const chosen=selectDiscoveredChannel(pending.result,channelKey),targetProfile=deriveProfileKey(pending.platform,chosen.channelKey),retained=this.sessions.get(`${workspaceId}:login`),loginKey=retained?.profileKey;
    await this.closeLogin(workspaceId);const layout=this.layout(workspaceId),store=new SqliteControlPlaneStore(layout.databasePath);
    try{if(loginKey)seedChannelProfile({profilesRoot:layout.profilesDir,fromProfileKey:loginKey,toProfileKey:targetProfile});new SetupChannelRegistrationService(store).registerFromDiscovery({result:pending.result,channelKey:chosen.channelKey,checkId:`check:${workspaceId}:${chosen.channelKey}:${Date.now()}`,now:new Date().toISOString(),actor:this.actor(),...(loginKey?{profileKey:targetProfile}:{})});}
    finally{store.close();}this.discoveries.delete(workspaceId);
  }

  private async driveConnect(workspaceId:string,res:ServerResponse):Promise<void>{const oauth=this.options.driveOAuth;if(!oauth)throw new Error("Google OAuth is not configured");const pending=oauth.begin(workspaceId);this.pendingAuth.set(workspaceId,{state:pending.state,codeVerifier:pending.codeVerifier});this.redirect(res,pending.authorizationUrl);}
  private async driveCallback(workspaceId:string,url:URL,res:ServerResponse):Promise<void>{const oauth=this.options.driveOAuth,pending=this.pendingAuth.get(workspaceId);if(!oauth||!pending)throw new Error("No pending Google login");if(url.searchParams.get("state")!==pending.state)throw new Error("OAuth state mismatch");const code=url.searchParams.get("code");if(!code)throw new Error(`Google login failed: ${url.searchParams.get("error")??"no code"}`);const credential=await oauth.complete(workspaceId,code,pending.codeVerifier);this.credentials(workspaceId).write(credential);this.pendingAuth.delete(workspaceId);this.redirect(res,`/workspaces/${workspaceId}`);}

  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    if(!this.authorized(req)){this.deny(res);return;}const method=req.method??"GET",url=new URL(req.url??"/","http://127.0.0.1"),path=url.pathname;
    try{
      if(method==="GET"&&path==="/"){res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(this.home());return;}
      const ws=path.match(/^\/workspaces\/([^/]+)$/);if(method==="GET"&&ws){res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(this.workspacePage(decodeURIComponent(ws[1]!)));return;}
      const browse=path.match(/^\/workspaces\/([^/]+)\/browse$/);if(method==="GET"&&browse){const html=await this.browsePage(decodeURIComponent(browse[1]!),url.searchParams.get("folderId")??"root");res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;}
      const callback=path.match(/^\/workspaces\/([^/]+)\/drive\/callback$/);if(method==="GET"&&callback){await this.driveCallback(decodeURIComponent(callback[1]!),url,res);return;}
      if(method!=="POST"){res.statusCode=404;res.end("Not found");return;}const params=await readForm(req);if(params.get("csrf")!==this.csrf){res.statusCode=403;res.end("Invalid CSRF token");return;}
      if(path==="/workspaces"){const item=new WorkspaceService(this.registry,this.options.runtimeRoot).create({workspaceId:params.get("workspaceId")??"",displayName:params.get("displayName")??"",timezone:params.get("timezone")??"Europe/Vienna",now:new Date().toISOString()});this.redirect(res,`/workspaces/${item.workspace.workspaceId}`);return;}
      let hit;
      if((hit=path.match(/^\/workspaces\/([^/]+)\/drive\/connect$/))){await this.driveConnect(decodeURIComponent(hit[1]!),res);return;}
      if((hit=path.match(/^\/workspaces\/([^/]+)\/folder$/))){const id=decodeURIComponent(hit[1]!),adapter=this.options.sourceFactory?.forWorkspace(id);if(!adapter)throw new Error("No source adapter configured");const folderId=(params.get("folderId")??"").trim(),folderPath=(params.get("folderPath")??"").trim();const preview=await adapter.browser.previewFolder(folderId);this.selections.set(id,{folderId,folderPath,preview,selectedAt:new Date().toISOString()});this.redirect(res,`/workspaces/${id}`);return;}
      if((hit=path.match(/^\/workspaces\/([^/]+)\/lane$/))){
        const id=decodeURIComponent(hit[1]!),selected=this.selections.get(id);if(!selected)throw new Error("No folder selected");const adapter=this.options.sourceFactory?.forWorkspace(id);if(!adapter)throw new Error("No source adapter configured");const technical=await adapter.resolver.resolveSelectedFolder(selected.folderId),config=new JsonDistributionConfigurationStore(resolve(this.layout(id).configDir,"distribution.json"));
        const result=new SetupDistributionOnboardingService(config).registerLane({provider:adapter.provider,folderRef:technical.folderRef,folderPath:selected.folderPath,interpretSubstructure:params.get("interpretSubstructure")==="on",activationMode:params.get("activationMode")==="IMPORT_BACKLOG"?"IMPORT_BACKLOG":"NEW_ONLY",now:new Date().toISOString()});
        if(result.cursor.mode==="NEW_ONLY"){const activation=new WorkspaceSourceActivationCommands({runtimeRoot:this.options.runtimeRoot,workspaceId:id});try{await activation.captureBaseline(result.lane.laneId,new Date().toISOString());}finally{activation.close();}}
        this.selections.delete(id);this.redirect(res,`/workspaces/${id}`);return;
      }
      if((hit=path.match(/^\/workspaces\/([^/]+)\/browser\/open$/))){const id=decodeURIComponent(hit[1]!);await this.openLogin(id,platform(params.get("platform")??""),(params.get("slot")??"primary").trim()||"primary");this.redirect(res,`/workspaces/${id}`);return;}
      if((hit=path.match(/^\/workspaces\/([^/]+)\/browser\/close$/))){const id=decodeURIComponent(hit[1]!);await this.closeLogin(id);this.redirect(res,`/workspaces/${id}`);return;}
      if((hit=path.match(/^\/workspaces\/([^/]+)\/discover$/))){const id=decodeURIComponent(hit[1]!);await this.discover(id);this.redirect(res,`/workspaces/${id}`);return;}
      if((hit=path.match(/^\/workspaces\/([^/]+)\/channel$/))){const id=decodeURIComponent(hit[1]!);await this.confirmChannel(id,(params.get("channelKey")??"").trim());this.redirect(res,`/workspaces/${id}`);return;}
      res.statusCode=404;res.end("Not found");
    }catch(error){res.statusCode=409;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end(error instanceof Error?error.message:String(error));}
  }

  async start():Promise<{host:string;port:number}>{if(this.server)throw new Error("Product setup already started");const host=this.options.host??"127.0.0.1",port=this.options.port??0;this.server=createServer((req,res)=>{void this.handle(req,res);});await new Promise<void>(resolvePromise=>this.server!.listen(port,host,resolvePromise));const address=this.server.address();if(!address||typeof address==="string")throw new Error("Product setup did not expose TCP address");return{host,port:address.port};}
  async stop():Promise<void>{for(const workspaceId of [...new Set([...this.sessions.keys()].map(key=>key.split(":")[0]!))])await this.closeLogin(workspaceId);if(!this.server)return;const server=this.server;this.server=undefined;await new Promise<void>((resolvePromise,reject)=>server.close(error=>error?reject(error):resolvePromise()));}
}
