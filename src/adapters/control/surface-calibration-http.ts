import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { SurfaceCalibrationCommandPort } from "../../domain/surface-calibration-command-ports.js";

function esc(value:string):string{return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function basic(header:string|string[]|undefined):{username:string;password:string}|null{if(typeof header!=="string"||!header.startsWith("Basic "))return null;try{const raw=Buffer.from(header.slice(6),"base64").toString("utf8"),i=raw.indexOf(":");return i<0?null:{username:raw.slice(0,i),password:raw.slice(i+1)};}catch{return null;}}
async function form(req:IncomingMessage):Promise<URLSearchParams>{return await new Promise(resolve=>{let body="";req.on("data",chunk=>{body+=chunk.toString();});req.on("end",()=>resolve(new URLSearchParams(body)));});}
function required(params:URLSearchParams,key:string):string{const value=(params.get(key)??"").trim();if(!value)throw new Error(`${key} is required`);return value;}

export interface SurfaceCalibrationHttpOptions {password:string;username?:string;host?:string;port?:number;now?:()=>string;controlCenterBaseUrl?:string;}

export class SurfaceCalibrationHttpServer {
  private server:Server|undefined;
  private readonly csrf=randomBytes(24).toString("hex");
  private readonly now:()=>string;
  constructor(private readonly config:DistributionConfigurationStorePort,private readonly commands:SurfaceCalibrationCommandPort,private readonly options:SurfaceCalibrationHttpOptions){if(!options.password)throw new Error("Calibration UI password is required");this.now=options.now??(()=>new Date().toISOString());}
  private authorized(req:IncomingMessage):boolean{const auth=basic(req.headers.authorization);return Boolean(auth&&auth.username===(this.options.username??"flerdvision")&&auth.password===this.options.password);}
  private deny(res:ServerResponse):void{res.statusCode=401;res.setHeader("WWW-Authenticate",'Basic realm="Flerdvision Calibration"');res.end("Authentication required");}
  private redirect(res:ServerResponse,location="/"):void{res.statusCode=303;res.setHeader("Location",location);res.end();}
  private action(path:string,routeId:string,label:string,stepKey?:string):string{return`<form method=post action="${path}" style="display:inline"><input type=hidden name=csrf value="${this.csrf}"><input type=hidden name=routeId value="${esc(routeId)}">${stepKey?`<input type=hidden name=stepKey value="${esc(stepKey)}">`:""}<button>${esc(label)}</button></form>`;}
  private page():string{
    const routes=this.config.load().config.routes.filter(route=>route.enabled),control=(this.options.controlCenterBaseUrl??"http://127.0.0.1:8790").replace(/\/$/,"");
    const cards=routes.map(route=>{let status;try{status=this.commands.status(route.routeId);}catch(error){return`<article class="card bad"><h2>${esc(route.displayName)}</h2><p>${esc(error instanceof Error?error.message:String(error))}</p></article>`;}
      const steps=status.steps.map(step=>{
        let controls:string;
        if(!status.browserOpen)controls='<span class=muted>Browser zuerst öffnen</span>';
        else if(step.specialCapture==="FILE_INPUT")controls=this.action("/capture",route.routeId,"Eindeutigen File-Input erfassen",step.stepKey);
        else if(step.armed)controls=`<strong class=warn>ARMED</strong> — jetzt im Social-Browser genau dieses UI-Element ${step.actionMode==="BLOCK_ACTION"?"anklicken (der Klick wird blockiert)":"anklicken"}, danach ${this.action("/capture",route.routeId,"Capture speichern",step.stepKey)}`;
        else controls=this.action("/arm",route.routeId,step.actionMode==="BLOCK_ACTION"?"Safe blocker armen":"Beobachtung armen",step.stepKey);
        return`<tr><td><code>${esc(step.stepKey)}</code><br><small>${esc(step.label)}</small></td><td>${esc(step.actionMode)}</td><td>${step.observations}</td><td>${controls}</td></tr>`;
      }).join("");
      const contract=status.contractStatus==="MISSING"?'<span class=bad>MISSING</span>':`<strong class="${status.contractStatus==="CALIBRATED"?"ok":"warn"}">${esc(status.contractStatus)}</strong>${status.contractId?`<br><code>${esc(status.contractId)}</code>`:""}`;
      const browser=status.browserOpen?`${this.action("/close",route.routeId,"Calibration-Browser schließen")} <span class=ok>OPEN</span>`:this.action("/open",route.routeId,"Calibration-Browser öffnen");
      const build=this.action("/build",route.routeId,status.contractStatus==="MISSING"?"Recorded Contract bauen":"Contract aus aktuellen Observations neu bauen");
      const replay=status.contractStatus==="RECORDED"?`<div class=next><strong>Nächster Gate:</strong> ${status.replayPasses}/3 sichere PREPARE_ONLY-Replays. <a href="${esc(control)}/test-lab">Test Lab öffnen</a>. Nach 3 passenden Replays wird der Contract automatisch CALIBRATED.</div>`:status.contractStatus==="CALIBRATED"?`<div class="next ok">Surface qualifiziert. Normales Test Lab kann jetzt SURFACE → VERIFICATION ausführen.</div>`:"";
      return`<article class=card><h2>${esc(route.displayName)}</h2><p>${esc(status.platform)} · ${esc(status.format)} · <code>${esc(status.accountId)}</code></p><div class=grid><div><strong>Browser</strong><p>${browser}</p></div><div><strong>Contract</strong><p>${contract}</p>${build}</div><div><strong>Replay</strong><p>${status.replayPasses}/3</p></div></div><table><tr><th>Recipe step</th><th>Mode</th><th>Obs.</th><th>Operator action</th></tr>${steps}</table>${replay}</article>`;
    }).join("");
    return`<!doctype html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Flerdvision Surface Calibration</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#f5f7f6;color:#18221f;max-width:1400px;margin:0 auto;padding:28px}.card{background:#fff;border:1px solid #dfe5e2;border-radius:12px;padding:18px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(3,minmax(180px,1fr));gap:12px}.ok{color:#21704a}.warn{color:#8a6516}.bad{color:#aa392f}.muted{color:#697671}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #e7ecea;vertical-align:top}button{font:inherit;padding:7px 10px;border:1px solid #bec8c5;border-radius:6px;background:#fff;cursor:pointer}code{background:#edf1ef;padding:2px 4px;border-radius:4px}.next{margin-top:14px;padding:10px 12px;border-left:4px solid #b57919;background:#faf7ef}</style></head><body><p><a href="${esc(control)}/test-lab">← Product Control Center / Test Lab</a></p><h1>Surface Calibration</h1><p>Human-in-the-loop Recorder → RECORDED SurfaceContract → 3× safe PREPARE_ONLY → CALIBRATED. Der Final-Action-Step wird beim Aufzeichnen geblockt und der Replay-Executor besitzt keinen Final-Click.</p>${cards||'<div class=card>Keine aktiven Routes.</div>'}</body></html>`;
  }
  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
    if(!this.authorized(req)){this.deny(res);return;}const method=req.method??"GET",path=new URL(req.url??"/","http://127.0.0.1").pathname;
    try{
      if(method==="GET"&&path==="/"){res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(this.page());return;}
      if(method!=="POST"){res.statusCode=404;res.end("Not found");return;}const params=await form(req);if(params.get("csrf")!==this.csrf){res.statusCode=403;res.end("Invalid CSRF token");return;}
      const routeId=required(params,"routeId");
      if(path==="/open")await this.commands.openBrowser(routeId,this.now());
      else if(path==="/close")await this.commands.closeBrowser(routeId);
      else if(path==="/arm")await this.commands.armStep(routeId,required(params,"stepKey"));
      else if(path==="/capture")await this.commands.captureStep(routeId,required(params,"stepKey"),this.now());
      else if(path==="/build")this.commands.buildRecordedContract(routeId,this.now());
      else{res.statusCode=404;res.end("Not found");return;}
      this.redirect(res);
    }catch(error){res.statusCode=409;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end(error instanceof Error?error.message:String(error));}
  }
  async start():Promise<{host:string;port:number}>{if(this.server)throw new Error("Calibration UI already started");const host=this.options.host??"127.0.0.1",port=this.options.port??0;this.server=createServer((req,res)=>{void this.handle(req,res);});await new Promise<void>(resolve=>this.server!.listen(port,host,resolve));const address=this.server.address();if(!address||typeof address==="string")throw new Error("Calibration UI did not expose TCP address");return{host,port:address.port};}
  async stop():Promise<void>{if(!this.server)return;const server=this.server;this.server=undefined;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
