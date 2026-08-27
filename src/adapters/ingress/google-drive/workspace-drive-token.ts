import type { AccessTokenProvider } from "../google-drive.js";
import { FileDriveCredentialStore, FetchHttpJson } from "./drive-credentials.js";
import { RefreshingAccessToken } from "./google-oauth.js";

/**
 * Runtime Drive credentials are workspace-scoped. This factory never looks up the "first" workspace
 * and never falls back to another workspace's refresh token.
 */
export function workspaceDriveAccessTokenProvider(input:{
  configDir:string;
  env?:Record<string,string|undefined>;
  http?:FetchHttpJson;
}):AccessTokenProvider|null{
  const env=input.env??process.env;
  const stored=new FileDriveCredentialStore(input.configDir).read();
  if(!stored)return null;
  const clientId=env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret=env.GOOGLE_OAUTH_CLIENT_SECRET;
  if(!clientId||!clientSecret)throw new Error("Drive credential exists but GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET are not configured on this host");
  if(clientId!==stored.clientId)throw new Error("Workspace Drive credential was created for a different Google OAuth client_id");
  const refreshing=new RefreshingAccessToken({
    http:input.http??new FetchHttpJson(),
    client:{clientId,clientSecret,redirectUri:"http://127.0.0.1"},
    refreshToken:stored.refreshToken
  });
  return{getAccessToken:async()=>await refreshing.accessToken()};
}
