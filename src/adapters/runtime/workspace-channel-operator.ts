import { resolve } from "node:path";
import type { ActiveChannelOperatorSession, ChannelOperatorCapability, ChannelOperatorCommandPort } from "../../domain/channel-operator-ports.js";
import type { OperatorBrowserSession } from "../../application/browser-bootstrap.js";
import { BrowserBootstrapService } from "../../application/browser-bootstrap.js";
import { workspaceRuntimeLayout } from "../../application/workspaces.js";
import { BrowserProfileDirectoryResolver, DurableBrowserProfileLockAdapter, FileBrowserProfileLockAdapter } from "../browser/profile-lock.js";
import { ChromiumCdpRuntimeAdapter } from "../browser/chromium-cdp.js";
import { resolveChromiumExecutablePath } from "../browser/resolve-chromium.js";
import { SqliteControlPlaneStore } from "../storage/sqlite.js";

function bootstrapUrl(platform:string):string{
  if(platform==="instagram")return"https://www.instagram.com/";
  if(platform==="tiktok")return"https://www.tiktok.com/";
  if(platform==="youtube")return"https://www.youtube.com/";
  throw new Error(`Unsupported social platform: ${platform}`);
}

/**
 * Opens the account's own persistent Chromium profile for normal human login/2FA.
 * Closing the browser does NOT mark the session healthy; a calibrated probe must do that later.
 */
export class WorkspaceChannelOperatorCommands implements ChannelOperatorCommandPort {
  private readonly store:SqliteControlPlaneStore;
  private readonly bootstrap:BrowserBootstrapService;
  private readonly sessions=new Map<string,{view:ActiveChannelOperatorSession;session:OperatorBrowserSession}>();

  constructor(options:{runtimeRoot:string;workspaceId:string;chromiumExecutablePath?:string}){
    const layout=workspaceRuntimeLayout(resolve(options.runtimeRoot),options.workspaceId);
    this.store=new SqliteControlPlaneStore(layout.databasePath);
    const resolver=new BrowserProfileDirectoryResolver(layout.profilesDir);
    const locks=new DurableBrowserProfileLockAdapter(this.store,new FileBrowserProfileLockAdapter(resolver));
    const runtime=new ChromiumCdpRuntimeAdapter({profilesRoot:layout.profilesDir,executablePath:options.chromiumExecutablePath??resolveChromiumExecutablePath()});
    this.bootstrap=new BrowserBootstrapService(this.store,runtime,locks);
  }

  private identity(accountId:string){
    const account=this.store.getSocialAccount(accountId)?.account;
    if(!account||!account.enabled)throw new Error(`Social account ${accountId} is missing or disabled`);
    const identities=this.store.listBrowserIdentities().map(record=>record.identity).filter(identity=>identity.accountId===accountId&&identity.enabled);
    if(identities.length!==1)throw new Error(`Account ${accountId} requires exactly one enabled browser identity; found ${identities.length}`);
    return{account,identity:identities[0]!};
  }

  capabilities(accountId:string):readonly ChannelOperatorCapability[]{
    try{
      this.identity(accountId);
      const open=this.sessions.has(accountId);
      return[
        {action:"OPEN_LOGIN_BROWSER",available:!open,reason:open?"A login browser for this account is already open.":"Opens the isolated persistent account profile for normal login/2FA."},
        {action:"CLOSE_LOGIN_BROWSER",available:open,reason:open?"Closes the operator browser and releases the profile lease.":"No operator login browser is open."},
        {action:"VERIFY_SESSION",available:false,reason:"Session verification requires a calibrated platform identity probe; closing login never marks HEALTHY automatically."}
      ];
    }catch(error){
      const reason=error instanceof Error?error.message:String(error);
      return[{action:"OPEN_LOGIN_BROWSER",available:false,reason},{action:"CLOSE_LOGIN_BROWSER",available:false,reason},{action:"VERIFY_SESSION",available:false,reason:"Session verification requires a valid account identity and calibrated probe."}];
    }
  }

  active(accountId:string):ActiveChannelOperatorSession|null{return this.sessions.get(accountId)?.view??null;}

  async openLoginBrowser(accountId:string,now:string):Promise<ActiveChannelOperatorSession>{
    if(this.sessions.has(accountId))throw new Error(`Account ${accountId} already has an open operator browser`);
    const {account,identity}=this.identity(accountId),openedAt=new Date(now).toISOString(),url=bootstrapUrl(account.platform);
    const session=await this.bootstrap.openForOperator({identityId:identity.identityId,ownerId:`control-center:reauth:${accountId}`,bootstrapUrl:url,now:openedAt,headless:false});
    const view:ActiveChannelOperatorSession={accountId,identityId:identity.identityId,profileDirectory:session.profileDirectory,openedAt,bootstrapUrl:url};
    this.sessions.set(accountId,{view,session});
    return view;
  }

  async closeLoginBrowser(accountId:string):Promise<boolean>{
    const active=this.sessions.get(accountId);if(!active)return false;
    this.sessions.delete(accountId);
    await active.session.close();
    return true;
  }

  async close():Promise<void>{
    const active=[...this.sessions.values()];this.sessions.clear();
    for(const item of active)await item.session.close().catch(()=>{});
    this.store.close();
  }
}
