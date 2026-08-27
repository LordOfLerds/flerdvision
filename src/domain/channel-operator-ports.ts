export interface ChannelOperatorCapability {
  action:"OPEN_LOGIN_BROWSER"|"CLOSE_LOGIN_BROWSER"|"VERIFY_SESSION";
  available:boolean;
  reason:string;
}

export interface ActiveChannelOperatorSession {
  accountId:string;
  identityId:string;
  profileDirectory:string;
  openedAt:string;
  bootstrapUrl:string;
}

export interface ChannelOperatorCommandPort {
  capabilities(accountId:string):readonly ChannelOperatorCapability[];
  active(accountId:string):ActiveChannelOperatorSession|null;
  openLoginBrowser(accountId:string,now:string):Promise<ActiveChannelOperatorSession>;
  closeLoginBrowser(accountId:string):Promise<boolean>;
}
