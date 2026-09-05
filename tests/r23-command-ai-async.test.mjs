import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommandAiDiagnosisAdapter } from "../dist/adapters/repair/command-ai.js";

function bundle() {
  return {
    bundleId: "bundle:test",
    incidentId: "incident:test",
    capturedAt: "2026-09-05T12:00:00.000Z",
    releaseSha: "release:test",
    adapterVersion: "surface:test",
    redactionPolicyVersion: "test",
    incidentKind: "UI_UNKNOWN",
    incidentSummary: "button changed",
    sanitizedContext: {},
    artifacts: [],
    redactionFindings: []
  };
}

test("a slow diagnosis command does not block the Node event loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-ai-async-"));
  const script = join(dir, "diagnose.mjs");
  writeFileSync(script, `let s=''; for await (const c of process.stdin) s+=c; setTimeout(()=>process.stdout.write(JSON.stringify({classification:'SELECTOR_DRIFT',confidence:0.9,rootCause:'label changed',evidenceRationale:['fixture'],proposedRepairKind:'SELECTOR_CONFIG_CHANGE',requiresHuman:false,securityNotes:[]})),80);`);
  try {
    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 10);
    const adapter = new CommandAiDiagnosisAdapter({ command: process.execPath, args: [script], timeoutMs: 1000 });
    const result = await adapter.diagnose(bundle());
    assert.equal(timerFired, true, "diagnosis must yield the event loop while the child process is running");
    assert.equal(result.classification, "SELECTOR_DRIFT");
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a hung diagnosis command is killed at the configured hard timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-ai-timeout-"));
  const script = join(dir, "hang.mjs");
  writeFileSync(script, `for await (const _ of process.stdin){}; setInterval(()=>{},1000);`);
  try {
    const adapter = new CommandAiDiagnosisAdapter({ command: process.execPath, args: [script], timeoutMs: 40 });
    await assert.rejects(() => adapter.diagnose(bundle()), /timed out after 40ms/);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
