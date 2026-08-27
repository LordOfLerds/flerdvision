import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { DistributionManagementService } from "../dist/application/distribution-management.js";
import { ControlCenterHttpServer } from "../dist/adapters/control/control-center-http.js";

const auth = `Basic ${Buffer.from("flerdvision:secret").toString("base64")}`;

function input(html, name) {
  const match = new RegExp(`name=${name} value="?([^" >]+)`).exec(html) ?? new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!match) throw new Error(`missing input ${name}`);
  return match[1];
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flerdvision-control-"));
  const store = new JsonDistributionConfigurationStore(join(root, "distribution.json"));
  const management = new DistributionManagementService(store);
  let rev = 0;
  rev = management.saveSource({ connectionId: "src", displayName: "Demo Drive", kind: "local_folder", rootRef: "mount:demo", enabled: true, disposition: { mode: "database_only", leavePartialUntouched: true, leaveBlockedUntouched: true } }, rev, "2026-08-27T06:00:00.000Z").stored.revision;
  rev = management.saveLane({ laneId: "lane", connectionId: "src", displayName: "Piet Main", folderRef: "folder:piet", folderPath: "Piet / Mittwoch", interpretation: { kind: "flat" }, enabled: true }, rev, "2026-08-27T06:01:00.000Z").stored.revision;
  rev = management.saveActivationCursor({ laneId: "lane", mode: "NEW_ONLY", activatedAt: "2026-08-27T06:01:00.000Z" }, rev, "2026-08-27T06:01:00.000Z").stored.revision;
  rev = management.savePostingProfile({ postingProfileId: "ig-normal", displayName: "IG Normal", platform: "instagram", format: "reel", commentsEnabled: true, shareToFeed: true, crosspostFacebook: false, enabled: true }, rev, "2026-08-27T06:02:00.000Z").stored.revision;
  rev = management.savePostingProfile({ postingProfileId: "ig-trial", displayName: "IG Trial", platform: "instagram", format: "trial_reel", commentsEnabled: true, shareToFeed: false, crosspostFacebook: false, enabled: true }, rev, "2026-08-27T06:02:30.000Z").stored.revision;
  rev = management.saveCopyProfile({ copyProfileId: "copy", displayName: "Piet Standard", versionId: "v1", strategy: "template", enabled: true }, rev, "2026-08-27T06:03:00.000Z").stored.revision;
  rev = management.saveRoute({ routeId: "r1", displayName: "Piet IG", laneId: "lane", accountId: "ig1", platform: "instagram", postingProfileId: "ig-normal", copyProfileId: "copy", schedulePolicyId: "default", requirement: "REQUIRED", enabled: true }, rev, "2026-08-27T06:04:00.000Z").stored.revision;

  const runtime = {
    async snapshot(date) {
      return {
        plan: {
          planId: `plan:${date}`,
          businessDate: date,
          generatedAt: "2026-08-27T06:30:00.000Z",
          deliveries: [{ deliveryId: "d1", routeId: "r1", assetId: "a1", contentId: "c1", creatorId: "piet", laneId: "lane", accountId: "ig1", platform: "instagram", format: "reel", postingProfileId: "ig-normal", copyProfileId: "copy", copyVersionId: "v1", requirement: "REQUIRED", businessDate: date, slotKey: "slot-1", scheduledFor: "2026-08-27T07:00:00.000Z", windowStartAt: "2026-08-27T06:30:00.000Z", windowEndAt: "2026-08-27T07:30:00.000Z" }],
          gaps: [{ gapId: "g1", kind: "MISSING_CONTENT", businessDate: date, routeId: "r1", accountId: "ig1", slotKey: "slot-4", reason: "No content for 17:00" }],
          backlog: []
        },
        accounts: [{ accountId: "ig1", platform: "instagram", expectedHandle: "piet", enabled: true }, { accountId: "tt1", platform: "tiktok", expectedHandle: "piet", enabled: true }],
        channelReadiness: [{ accountId: "ig1", sessionHealth: "HEALTHY", identityVerified: true, surfaceContract: "CALIBRATED" }, { accountId: "tt1", sessionHealth: "HEALTHY", identityVerified: true, surfaceContract: "CALIBRATED" }],
        routeTests: [{ routeId: "r1", sourcePassed: true, sessionPassed: true, identityPassed: true, prepareOnlyPasses: 3, secretLivePassed: false, verificationPassed: true, cleanupPassed: false }],
        assets: []
      };
    }
  };
  return { store, management, runtime };
}

async function withServer(fn) {
  const f = fixture();
  const server = new ControlCenterHttpServer(f.store, f.runtime, { password: "secret", now: () => "2026-08-27T07:17:00.000Z", businessDate: () => "2026-08-27" });
  const { host, port } = await server.start();
  try { await fn({ ...f, base: `http://${host}:${port}` }); } finally { await server.stop(); }
}

async function get(base, path) {
  return await fetch(`${base}${path}`, { headers: { authorization: auth } });
}

async function post(base, path, values) {
  return await fetch(`${base}${path}`, { method: "POST", headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values), redirect: "manual" });
}

test("control center exposes Today, Sources, Routes and Profiles from one config/runtime model", async () => {
  await withServer(async ({ base }) => {
    const today = await get(base, "/today");
    const todayHtml = await today.text();
    assert.equal(today.status, 200);
    assert.match(todayHtml, /Today · 2026-08-27/);
    assert.match(todayHtml, /No content for 17:00/);
    assert.match(todayHtml, /Piet IG|ig1/);

    const sources = await get(base, "/sources");
    const sourceHtml = await sources.text();
    assert.match(sourceHtml, /Demo Drive/);
    assert.match(sourceHtml, /Piet Main/);
    assert.match(sourceHtml, /NEW_ONLY/);

    const routes = await get(base, "/routes");
    assert.match(await routes.text(), /Piet IG/);
    const profiles = await get(base, "/profiles");
    assert.match(await profiles.text(), /IG Normal/);
  });
});

test("route change requires impact preview before signed apply and increments revision", async () => {
  await withServer(async ({ base, store }) => {
    const routes = await get(base, "/routes");
    const html = await routes.text();
    const csrf = input(html, "csrf");
    const before = store.load().revision;

    const preview = await post(base, "/preview/route", {
      csrf,
      routeId: "r1",
      displayName: "Piet IG Trial",
      laneId: "lane",
      accountId: "ig1",
      postingProfileId: "ig-trial",
      copyProfileId: "copy",
      schedulePolicyId: "default",
      requirement: "REQUIRED",
      enabled: "on"
    });
    assert.equal(preview.status, 200);
    const previewHtml = await preview.text();
    assert.match(previewHtml, /Auswirkungsprüfung/);
    assert.match(previewHtml, /Route-Test erneut erforderlich: <strong>JA/);
    assert.equal(store.load().revision, before, "preview must not write");

    const apply = await post(base, "/apply", {
      csrf,
      payload: input(previewHtml, "payload"),
      signature: input(previewHtml, "signature"),
      revision: input(previewHtml, "revision")
    });
    assert.equal(apply.status, 303);
    assert.equal(apply.headers.get("location"), "/routes");
    const after = store.load();
    assert.equal(after.revision, before + 1);
    assert.equal(after.config.routes.find((r) => r.routeId === "r1").postingProfileId, "ig-trial");
  });
});

test("stale preview cannot overwrite a newer configuration revision", async () => {
  await withServer(async ({ base, store, management }) => {
    const routesHtml = await (await get(base, "/routes")).text();
    const csrf = input(routesHtml, "csrf");
    const preview = await post(base, "/preview/route", {
      csrf, routeId: "r1", displayName: "Stale", laneId: "lane", accountId: "ig1", postingProfileId: "ig-normal", copyProfileId: "copy", schedulePolicyId: "default", requirement: "REQUIRED", enabled: "on"
    });
    const previewHtml = await preview.text();
    const current = store.load();
    management.saveCopyProfile({ copyProfileId: "copy", displayName: "New Copy", versionId: "v2", strategy: "template", enabled: true }, current.revision, "2026-08-27T07:18:00.000Z");

    const apply = await post(base, "/apply", { csrf, payload: input(previewHtml, "payload"), signature: input(previewHtml, "signature"), revision: input(previewHtml, "revision") });
    assert.equal(apply.status, 409);
    assert.match(await apply.text(), /revision changed/);
    assert.notEqual(store.load().config.routes.find((r) => r.routeId === "r1").displayName, "Stale");
  });
});

test("route preview rejects a channel/profile platform mismatch before any write", async () => {
  await withServer(async ({ base, store }) => {
    const html = await (await get(base, "/routes")).text();
    const csrf = input(html, "csrf");
    const before = store.load().revision;
    const response = await post(base, "/preview/route", {
      csrf, routeId: "bad", displayName: "Bad", laneId: "lane", accountId: "tt1", postingProfileId: "ig-normal", copyProfileId: "copy", schedulePolicyId: "default", requirement: "REQUIRED", enabled: "on"
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /different platforms/);
    assert.equal(store.load().revision, before);
  });
});
