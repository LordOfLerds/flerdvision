import { basename, resolve } from "node:path";
import { JsonWorkspaceRegistry } from "../adapters/workspace/json-registry.js";
import { ProductSetupHttpServer, type ProductSetupDriveOAuthPort, type ProductSetupSourceAdapterFactory } from "../adapters/setup/product-setup-http.js";
import { resolveChromiumExecutablePath } from "../adapters/browser/resolve-chromium.js";
import { GoogleDriveFolderBrowser, DRIVE_ROOT } from "../adapters/ingress/google-drive/google-drive-browser.js";
import { LocalFolderBrowser } from "../adapters/ingress/local/local-folder-browser.js";
import { FetchHttpJson, FileDriveCredentialStore, driveOAuthClientFromEnv } from "../adapters/ingress/google-drive/drive-credentials.js";
import { RefreshingAccessToken, beginAuthorization, exchangeAuthorizationCode } from "../adapters/ingress/google-drive/google-oauth.js";
import { workspaceRuntimeLayout } from "../application/workspaces.js";

function arg(name:string):string|undefined{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;}

const runtimeRoot=resolve(arg("--runtime-root")??process.env.FLERDVISION_RUNTIME_ROOT??"runtime");
const password=arg("--password")??process.env.FLERDVISION_SETUP_PASSWORD;
if(!password)throw new Error("Set --password or FLERDVISION_SETUP_PASSWORD");
const host=arg("--host")??"127.0.0.1",port=Number(arg("--port")??"8788"),http=new FetchHttpJson();
const registry=new JsonWorkspaceRegistry(resolve(runtimeRoot,"registry","workspaces.json"));
const sourceRoot=arg("--source-root")??process.env.FLERDVISION_SOURCE_ROOT;

function localSourceFactory(root:string):ProductSetupSourceAdapterFactory{
  const absolute=resolve(root),browser=new LocalFolderBrowser({root:absolute});
  return{forWorkspace(){return{browser,resolver:browser,provider:{kind:"local_folder",rootRef:absolute,displayName:`Mounted Source · ${basename(absolute)}`}};}};
}

function driveWiring():{oauth?:ProductSetupDriveOAuthPort;sourceFactory?:ProductSetupSourceAdapterFactory}{
  const placeholder=`http://${host}:${port}/workspaces/WORKSPACE/drive/callback`;
  const base=driveOAuthClientFromEnv(process.env,placeholder);
  if(!base)return{};
  const clientFor=(workspaceId:string)=>({...base,redirectUri:`http://${host}:${port}/workspaces/${workspaceId}/drive/callback`});
  const oauth:ProductSetupDriveOAuthPort={
    begin(workspaceId){return beginAuthorization(clientFor(workspaceId));},
    async complete(workspaceId,code,codeVerifier){
      const client=clientFor(workspaceId),tokens=await exchangeAuthorizationCode({http,client,code,codeVerifier,now:Date.now()});
      return{clientId:client.clientId,refreshToken:tokens.refreshToken!,connectedAt:new Date().toISOString()};
    }
  };
  const sourceFactory:ProductSetupSourceAdapterFactory={
    forWorkspace(workspaceId){
      const configDir=workspaceRuntimeLayout(runtimeRoot,workspaceId).configDir;
      const stored=new FileDriveCredentialStore(configDir).read();
      if(!stored)throw new Error(`Workspace ${workspaceId} is not connected to Google Drive`);
      const token=new RefreshingAccessToken({http,client:clientFor(workspaceId),refreshToken:stored.refreshToken});
      const browser=new GoogleDriveFolderBrowser({http,token});
      return{browser,resolver:browser,provider:{kind:"google_drive",rootRef:DRIVE_ROOT,displayName:"Google Drive"}};
    }
  };
  return{oauth,sourceFactory};
}

const localFactory=sourceRoot?localSourceFactory(sourceRoot):undefined;
const drive=localFactory?{}:driveWiring();
const sourceFactory=localFactory??drive.sourceFactory;
const server=new ProductSetupHttpServer(registry,{
  runtimeRoot,
  password,
  username:arg("--username")??"flerdvision",
  host,
  port,
  chromiumExecutablePath:arg("--chromium")??resolveChromiumExecutablePath(),
  ...(sourceFactory?{sourceFactory}:{}),
  ...(drive.oauth?{driveOAuth:drive.oauth}:{}),
  ...(process.env.FLERDVISION_UI_BASE_URL?{controlCenterBaseUrl:process.env.FLERDVISION_UI_BASE_URL}:{})
  // channelDiscovery remains intentionally unset until a real surface contract is calibrated.
});

const listening=await server.start();
console.log(`Flerdvision product setup listening on http://${listening.host}:${listening.port}`);
if(localFactory)console.log(`Source mode: mounted folder ${resolve(sourceRoot!)}; no cloud credential required.`);
else if(!sourceFactory)console.log("No source configured. Pass --source-root or configure Google OAuth.");
console.log("Onboarding creates Source Lanes and Channels independently; route them in Control Center / Programs.");
console.log("Channel discovery remains unavailable until calibrated; typed handles are never accepted as a substitute.");
await new Promise<void>(resolvePromise=>{process.on("SIGINT",resolvePromise);process.on("SIGTERM",resolvePromise);});
await server.stop();
