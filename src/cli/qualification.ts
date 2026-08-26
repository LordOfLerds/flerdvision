import { resolve } from "node:path";
import { JsonWorkspaceRegistry } from "../adapters/workspace/json-registry.js";
import { ReleaseQualificationService } from "../application/release-qualification.js";
import type { DeploymentStage, QualificationGateKind } from "../domain/workspace.js";
function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
function required(name: string): string { const value = arg(name); if (!value) throw new Error(`Missing ${name}`); return value; }
const command = process.argv[2] ?? "help"; const root = resolve(arg("--runtime-root") ?? process.env.FLERDVISION_RUNTIME_ROOT ?? "runtime");
const store = new JsonWorkspaceRegistry(resolve(root, "registry", "workspaces.json")); const service = new ReleaseQualificationService(store); const operatorId = arg("--operator") ?? "operator";
if (command === "start") console.log(JSON.stringify(service.start({ ...(arg("--run-id") ? { runId: arg("--run-id")! } : {}), releaseSha: required("--release-sha"), stage: required("--stage") as DeploymentStage, workspaceId: required("--workspace-id"), hostFingerprint: required("--host-fingerprint"), now: new Date().toISOString(), operatorId }), null, 2));
else if (command === "gate") console.log(JSON.stringify(service.recordGate({ runId: required("--run-id"), gate: required("--gate") as QualificationGateKind, passed: required("--passed") === "true", now: new Date().toISOString(), operatorId, summary: required("--summary") }), null, 2));
else if (command === "finalize") console.log(JSON.stringify(service.finalize(required("--run-id")), null, 2));
else if (command === "status") { const runId = required("--run-id"); console.log(JSON.stringify({ run: store.getRun(runId), gates: store.listGates(runId) }, null, 2)); }
else throw new Error("Usage: qualification start|gate|finalize|status");
