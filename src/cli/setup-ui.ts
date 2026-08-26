import { resolve } from "node:path";
import { JsonWorkspaceRegistry } from "../adapters/workspace/json-registry.js";
import { FixedCommandTestRunner } from "../adapters/test-lab/fixed-command-runner.js";
import { SelfServiceHttpServer } from "../adapters/setup/self-service-http.js";
import { resolveChromiumExecutablePath } from "../adapters/browser/resolve-chromium.js";
function arg(name:string):string|undefined{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;}
const runtimeRoot=resolve(arg("--runtime-root")??process.env.FLERDVISION_RUNTIME_ROOT??"runtime");const repoRoot=resolve(arg("--repo-root")??process.env.FLERDVISION_REPO_ROOT??process.cwd());const password=arg("--password")??process.env.FLERDVISION_SETUP_PASSWORD;if(!password)throw new Error("Set --password or FLERDVISION_SETUP_PASSWORD");
const registry=new JsonWorkspaceRegistry(resolve(runtimeRoot,"registry","workspaces.json"));const server=new SelfServiceHttpServer(registry,{runtimeRoot,repoRoot,password,username:arg("--username")??"flerdvision",host:arg("--host")??"127.0.0.1",port:Number(arg("--port")??"8788"),chromiumExecutablePath:arg("--chromium")??resolveChromiumExecutablePath(),testRunner:new FixedCommandTestRunner()});
const listening=await server.start();console.log(`Flerdvision self-service UI listening on http://${listening.host}:${listening.port}`);await new Promise<void>(resolvePromise=>{process.on("SIGINT",resolvePromise);process.on("SIGTERM",resolvePromise);});await server.stop();
