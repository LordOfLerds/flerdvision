import { resolve } from "node:path";
import { JsonWorkspaceRegistry } from "../adapters/workspace/json-registry.js";
import { WorkspaceService, workspaceRuntimeLayout } from "../application/workspaces.js";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function required(name: string): string { const value = arg(name); if (!value) throw new Error(`Missing ${name}`); return value; }
const command = process.argv[2] ?? "help";
const runtimeRoot = resolve(arg("--runtime-root") ?? process.env.FLERDVISION_RUNTIME_ROOT ?? "runtime");
const registry = new JsonWorkspaceRegistry(resolve(runtimeRoot, "registry", "workspaces.json"));
const service = new WorkspaceService(registry, runtimeRoot);

if (command === "init") console.log(JSON.stringify(service.create({ workspaceId: required("--workspace-id"), displayName: required("--name"), timezone: arg("--timezone") ?? "Europe/Vienna", now: new Date().toISOString() }), null, 2));
else if (command === "list") console.log(JSON.stringify(registry.list(), null, 2));
else if (command === "show") { const id = required("--workspace-id"); console.log(JSON.stringify({ workspace: registry.get(id), layout: workspaceRuntimeLayout(runtimeRoot, id) }, null, 2)); }
else throw new Error("Usage: workspace init|list|show [--runtime-root ...]");
