import test from "node:test";
import assert from "node:assert/strict";
import { projectContentQueue } from "../dist/application/control-center-content.js";
import { projectActivity } from "../dist/application/control-center-activity.js";
import { renderContentSection, renderRouteTestLabSection, renderIncidentsSection, renderActivitySection } from "../dist/adapters/control/control-center-sections.js";
import { incidentView } from "../dist/application/control-center-operator-surfaces.js";
import { buildRouteTestMatrix } from "../dist/application/route-test-matrix.js";

const asset = { assetId:"a1", contentId:"c1", laneId:"lane", creatorId:"piet", sourceObservationId:"o", sourceRef:"x", externalObjectId:"f1", filename:"01.mp4", mediaFingerprint:"sha", observedAt:"2026-08-27T06:00:00.000Z", state:"READY", metadata:{} };
const plan = { planId:"p", businessDate:"2026-08-27", generatedAt:"2026-08-27T06:30:00.000Z", deliveries:[{ deliveryId:"d", routeId:"r", assetId:"a1", contentId:"c1", creatorId:"piet", laneId:"lane", accountId:"ig1", platform:"instagram", format:"reel", postingProfileId:"pp", copyProfileId:"cp", copyVersionId:"v1", requirement:"REQUIRED", businessDate:"2026-08-27", slotKey:"s1", scheduledFor:"2026-08-27T07:00:00.000Z", windowStartAt:"2026-08-27T06:30:00.000Z", windowEndAt:"2026-08-27T07:30:00.000Z" }], gaps:[], backlog:[] };

test("Content section projects source lane, plan targets and aggregate status", () => {
  const items = projectContentQueue({ assets:[asset], plan, lanes:[{ laneId:"lane", connectionId:"src", displayName:"Piet", folderRef:"f", folderPath:"Piet / Mittwoch", interpretation:{kind:"flat"}, enabled:true }], routes:[], aggregates:[{ assetId:"a1", requiredDeliveryIds:["d"], optionalDeliveryIds:[], verifiedDeliveryIds:[], waivedDeliveryIds:[], failedDeliveryIds:[], status:"PENDING" }] });
  assert.equal(items[0].status, "PLANNED");
  const html = renderContentSection(items);
  assert.match(html, /01\.mp4/);
  assert.match(html, /Piet \/ Mittwoch/);
  assert.match(html, /ig1/);
});

test("Activity derives from canonical audit events and renders newest first", () => {
  const records = projectActivity([
    { sequence:1,eventId:"e1",aggregateType:"source_observation",aggregateId:"o1",eventType:"OBSERVED",occurredAt:"2026-08-27T06:00:00.000Z",actor:{type:"system",id:"ingress"},payload:{} },
    { sequence:2,eventId:"e2",aggregateType:"publication_intent",aggregateId:"i1",eventType:"STATE_CHANGED",occurredAt:"2026-08-27T07:00:00.000Z",actor:{type:"worker",id:"w"},fromState:"SCHEDULED",toState:"PREPARING",payload:{} }
  ]);
  assert.deepEqual(records.map((x)=>x.activityId), ["e2","e1"]);
  assert.match(renderActivitySection(records), /SCHEDULED → PREPARING/);
});

test("Incidents section never renders direct resume for PUBLISH_UNCERTAIN", () => {
  const view = incidentView({ incidentId:"inc",fingerprint:"f",kind:"PUBLISH_UNCERTAIN",severity:"CRITICAL",title:"Uncertain",summary:"Maybe posted",scope:{intentId:"i"},evidenceRefs:[],metadata:{},status:"OPEN",openedAt:"2026-08-27T07:00:00.000Z",lastObservedAt:"2026-08-27T07:00:00.000Z",occurrenceCount:1 });
  const html = renderIncidentsSection([view]);
  assert.match(html, /OPEN_RECONCILIATION/);
  assert.doesNotMatch(html, />RESUME</);
});

test("Test Lab section renders route-specific secret-live block", () => {
  const matrix = buildRouteTestMatrix({ route:{ routeId:"r",displayName:"Trial",laneId:"l",accountId:"ig",platform:"instagram",postingProfileId:"p",copyProfileId:"c",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true }, profile:{ postingProfileId:"p",displayName:"IG Trial",platform:"instagram",format:"trial_reel",commentsEnabled:true,shareToFeed:false,crosspostFacebook:false,enabled:true }, account:{accountId:"ig",platform:"instagram",expectedHandle:"piet",enabled:true}, channel:{accountId:"ig",sessionHealth:"HEALTHY",identityVerified:true,surfaceContract:"CALIBRATED"}, evidence:{routeId:"r",sourcePassed:true,sessionPassed:true,identityPassed:true,prepareOnlyPasses:3,secretLivePassed:false,verificationPassed:true,cleanupPassed:false} });
  const html=renderRouteTestLabSection([matrix]);
  assert.match(html,/Secret-live E2E/);
  assert.match(html,/BLOCKED/);
  assert.match(html,/non-followers/);
});
