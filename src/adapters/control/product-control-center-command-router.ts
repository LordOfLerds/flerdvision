import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DistributionConfigurationStorePort } from "../../domain/distribution-ports.js";
import type { ControlCenterRuntimePort } from "../../domain/control-center-ports.js";
import type { ExecutableRouteTestKey } from "../../domain/route-test-ports.js";
import type { RouteTestCommandPort } from "../../domain/route-test-command-ports.js";
import { buildRouteTestMatrix } from "../../application/route-test-matrix.js";
import { ProductControlCenterHttpServer, type ProductControlCenterHttpOptions } from "./product-control-center-http.js";

const EXECUTABLE_KEYS:readonly ExecutableRouteTestKey[]=["SOURCE","SESSION","IDENTITY","SURFACE","PREPARE_ONLY","VERIFICATION","CLEANUP"];
function esc(value:string):string{return value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
function basic(header:string|string[]|undefined):{username:string;password:string}|null{
  if(typeof header!=="string"||!header.startsWith("Basic "))return null;
  try{const decoded=Buffer.from(header.slice(6),"base64").toString("utf8"),i=decoded.indexOf(":");return i<0?null:{username:decoded.slice(0,i),password:decoded.slice(i+1)};}catch{return null;}
}
async function readForm(req:IncomingMessage):Promise<URLSearchParams>{return await new Promise(resolve=>{let body="";req.on("data",chunk=>{body+=chunk.toString();});req.on("end",()=>resolve(new URLSearchParams(body)));});}

export interface ProductControlCenterCommandRouterOptions extends ProductControlCenterHttpOptions {
  releaseSha:string;
}

/**
 * One external Control Center endpoint. The mature product server stays untouched behind a
 * loopback-only port; this router owns only command surfaces that require additional adapters.
 */
export class ProductControlCenterCommandRouter {
  private outer:Server|undefined;
  private readonly csrf=randomBytes(24).toString("hex");
  private innerAddress:{host:string;port:number}|undefined;
  private readonly inner:ProductControlCenterHttpServer;

  constructor(
    private readonly config:DistributionConfigurationStorePort,
    private readonly runtime:ControlCenterRuntimePort,
    private readonly routeTests:RouteTestCommandPort,
    private readonly options:ProductControlCenterCommandRouterOptions
  ){
    if(!options.releaseSha.trim())throw new Error("Control Center route-test router requires release SHA");
    this.inner=new ProductControlCenterHttpServer(config,runtime,{...options,host:"127.0.0.1",port:0});
  }

  private authorized(req:IncomingMessage):boolean{
    const auth=basic(req.headers.authorization);
    return Boolean(auth&&auth.username===(this.options.username??"flerdvision")&&auth.password===this.options.password);
  }
  private deny(res:ServerResponse):void{res.statusCode=401;res.setHeader("WWW-Authenticate",'Basic realm="Flerdvision Control"');res.end("Authentication required");}
  private redirect(res:ServerResponse,location:string):void{res.statusCode=303;res.setHeader("Location",location);res.end();}

  private async testLabPage():Promise<string>{
    const businessDate=this.options.businessDate?.()??new Date(this.options.now?.()??new Date()).toISOString().slice(0,10);
    const stored=this.config.load(),snapshot=await this.runtime.snapshot(businessDate);
    const rows=stored.config.routes.map(route=>{
      const profile=stored.config.postingProfiles.find(item=>item.postingProfileId===route.postingProfileId);
      const account=snapshot.accounts.find(item=>item.accountId===route.accountId);
      const channel=snapshot.channelReadiness.find(item=>item.accountId===route.accountId);
      const surface=snapshot.surfaceReadiness?.find(item=>item.accountId===route.accountId&&item.postingProfileId===route.postingProfileId);
      const evidence=snapshot.routeTests.find(item=>item.routeId===route.routeId);
      const matrix=buildRouteTestMatrix({route,profile,account,channel,surface,evidence});
      const capabilities=new Map(this.routeTests.capabilities(route.routeId).map(item=>[item.testKey,item]));
      const cases=matrix.cases.map(item=>{
        const capability=capabilities.get(item.testKey as ExecutableRouteTestKey);
        const run=capability?.executable
          ? `<form method=post action=/test-lab/run style="display:inline"><input type=hidden name=csrf value="${this.csrf}"><input type=hidden name=routeId value="${esc(route.routeId)}"><input type=hidden name=testKey value="${esc(item.testKey)}"><button>Run</button></form>`
          : `<span class=muted>${esc(capability?.reason??(item.testKey==="SECRET_LIVE"?"Nur über PrivateE2E + One-Shot-Permit.":"Nicht auf diesem Host ausführbar."))}</span>`;
        return `<tr><td>${esc(item.label)}</td><td>${esc(item.status)}</td><td>${esc(item.detail)}</td><td>${run}</td></tr>`;
      }).join("");
      return `<section class="card"><h2>${esc(route.displayName)}</h2><p><code>${esc(route.routeId)}</code> · ${esc(matrix.platform)} · ${esc(matrix.account)} · <strong>${esc(matrix.overall)}</strong></p><table><tr><th>Test</th><th>Status</th><th>Evidence</th><th>Action</th></tr>${cases}</table></section>`;
    }).join("");
    return `<!doctype html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Flerdvision Test Lab</title><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f5f7f6;color:#18221f}.layout{max-width:1300px;margin:auto;padding:28px}.top{display:flex;gap:16px;align-items:center}.top a{color:#075e58}.card{background:white;border:1px solid #dfe5e2;border-radius:11px;padding:16px 18px;margin:14px 0}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #e7ecea;text-align:left;vertical-align:top}.muted{color:#697671;font-size:13px}button{font:inherit;padding:6px 10px;border:1px solid #0e6b64;background:#0e6b64;color:white;border-radius:6px;cursor:pointer}code{background:#edf1ef;padding:2px 4px;border-radius:4px}</style></head><body><main class=layout><div class=top><h1>Route Test Lab</h1><a href=/today>← Control Center</a></div><p>Release <code>${esc(this.options.releaseSha.slice(0,12))}</code>. Normale Testbuttons können SECRET_LIVE technisch nicht ausführen.</p>${rows||'<div class=card>Keine Routes.</div>'}</main></body></html>`;
  }

  private async handleTestLab(req:IncomingMessage,res:ServerResponse,path:string):Promise<void>{
    if(!this.authorized(req)){this.deny(res);return;}
    if((req.method??"GET")==="GET"&&path==="/test-lab"){
      const html=await this.testLabPage();res.statusCode=200;res.setHeader("Content-Type","text/html; charset=utf-8");res.end(html);return;
    }
    if((req.method??"GET")==="POST"&&path==="/test-lab/run"){
      const params=await readForm(req);if(params.get("csrf")!==this.csrf){res.statusCode=403;res.end("Invalid CSRF token");return;}
      const routeId=(params.get("routeId")??"").trim(),raw=(params.get("testKey")??"").trim();
      if(!routeId)throw new Error("routeId is required");
      if(!EXECUTABLE_KEYS.includes(raw as ExecutableRouteTestKey))throw new Error("Unsupported route test key");
      await this.routeTests.run(routeId,raw as ExecutableRouteTestKey,this.options.now?.()??new Date().toISOString());
      this.redirect(res,`/test-lab?route=${encodeURIComponent(routeId)}&ran=${encodeURIComponent(raw)}`);return;
    }
    res.statusCode=404;res.end("Not found");
  }

  private proxy(req:IncomingMessage,res:ServerResponse):void{
    if(!this.innerAddress){res.statusCode=503;res.end("Control Center inner server is not ready");return;}
    const headers={...req.headers,host:`${this.innerAddress.host}:${this.innerAddress.port}`};
    const upstream=httpRequest({host:this.innerAddress.host,port:this.innerAddress.port,path:req.url??"/",method:req.method,headers},upstreamRes=>{
      res.statusCode=upstreamRes.statusCode??502;
      for(const [name,value] of Object.entries(upstreamRes.headers)){if(value!==undefined)res.setHeader(name,value);}
      upstreamRes.pipe(res);
    });
    upstream.on("error",error=>{if(!res.headersSent)res.statusCode=502;res.end(`Control Center proxy error: ${error.message}`);});
    req.pipe(upstream);
  }

  async start():Promise<{host:string;port:number}>{
    if(this.outer)throw new Error("Control Center command router already started");
    this.innerAddress=await this.inner.start();
    const host=this.options.host??"127.0.0.1",port=this.options.port??0;
    this.outer=createServer((req,res)=>{const path=new URL(req.url??"/","http://127.0.0.1").pathname;if(path==="/test-lab"||path==="/test-lab/run")void this.handleTestLab(req,res,path).catch(error=>{res.statusCode=400;res.setHeader("Content-Type","text/plain; charset=utf-8");res.end(error instanceof Error?error.message:String(error));});else this.proxy(req,res);});
    await new Promise<void>(resolve=>this.outer!.listen(port,host,resolve));
    const address=this.outer.address();if(!address||typeof address==="string")throw new Error("Control Center router did not expose TCP address");
    return{host,port:address.port};
  }

  async stop():Promise<void>{
    const outer=this.outer;this.outer=undefined;
    if(outer)await new Promise<void>((resolve,reject)=>outer.close(error=>error?reject(error):resolve()));
    await this.inner.stop();
  }
}
