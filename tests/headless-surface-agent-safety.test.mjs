import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandSurfaceAgent,
  SurfaceAgentProtocolError,
  surfaceAgentChildEnvironment
} from "../dist/adapters/browser/command-surface-agent.js";

function request(stepKey = "OPEN_CREATE", action = "CLICK") {
  return {
    schemaVersion: 1,
    objective: "LOCATE_SAFE_UI_STEP",
    stepKey,
    action,
    safety: {
      finalActionMayBeLocated: true,
      finalActionMayBeInvoked: false,
      credentialsIncluded: false,
      inputValuesIncluded: false
    },
    builtInCandidates: [],
    snapshot: {
      capturedAt: "2026-08-27T10:00:00Z",
      platform: "instagram",
      format: "reel",
      stepKey,
      currentUrl: "https://www.instagram.com/",
      title: "Instagram",
      elements: []
    }
  };
}

function outputAgent(payload) {
  const dir = mkdtempSync(join(tmpdir(), "flerdvision-surface-agent-"));
  const script = join(dir, "agent.mjs");
  writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`);
  return {
    agent: new CommandSurfaceAgent({ command: process.execPath, args: [script], env: { PATH: process.env.PATH, HOME: process.env.HOME } }),
    close: () => rmSync(dir, { recursive: true, force: true })
  };
}

test("surface agent child environment exposes only an explicit non-secret allowlist", () => {
  const child = surfaceAgentChildEnvironment({
    PATH: "/usr/bin",
    HOME: "/Users/luca",
    CLAUDE_CONFIG_DIR: "/Users/luca/.claude",
    GOOGLE_OAUTH_CLIENT_SECRET: "must-not-leak",
    FLERDVISION_NOTIFICATION_WEBHOOK_TOKEN: "must-not-leak",
    RANDOM_SAFE_VALUE: "safe",
    FLERDVISION_SURFACE_AGENT_FORWARD_ENV: "RANDOM_SAFE_VALUE"
  });
  assert.deepEqual(child, {
    PATH: "/usr/bin",
    HOME: "/Users/luca",
    CLAUDE_CONFIG_DIR: "/Users/luca/.claude",
    RANDOM_SAFE_VALUE: "safe"
  });
  assert.throws(() => surfaceAgentChildEnvironment({
    FLERDVISION_SURFACE_AGENT_FORWARD_ENV: "GOOGLE_OAUTH_CLIENT_SECRET",
    GOOGLE_OAUTH_CLIENT_SECRET: "must-not-leak"
  }), /Refusing to forward sensitive/);
});

test("Claude cannot propose opaque CSS or a publish label for an ordinary click", async () => {
  for (const locators of [
    [{ kind: "css", value: "button:nth-child(7)" }],
    [{ kind: "role", role: "button", value: "Share", exact: true }]
  ]) {
    const harness = outputAgent({ schemaVersion: 1, stepKey: "OPEN_CREATE", locators, rationale: "candidate" });
    try {
      await assert.rejects(() => harness.agent.propose(request()), SurfaceAgentProtocolError);
    } finally { harness.close(); }
  }
});

test("Claude may locate the final boundary but the protocol still gives it no click capability", async () => {
  const harness = outputAgent({
    schemaVersion: 1,
    stepKey: "FINAL_ACTION",
    locators: [{ kind: "role", role: "button", value: "Share", exact: true }],
    rationale: "Final irreversible boundary only"
  });
  try {
    const proposal = await harness.agent.propose(request("FINAL_ACTION", "FINAL_BOUNDARY"));
    assert.equal(proposal.locators[0].value, "Share");
    assert.equal(request("FINAL_ACTION", "FINAL_BOUNDARY").safety.finalActionMayBeInvoked, false);
  } finally { harness.close(); }
});
