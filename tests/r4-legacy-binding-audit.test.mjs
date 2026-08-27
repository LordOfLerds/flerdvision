import test from "node:test";
import assert from "node:assert/strict";
import { auditLegacySourceBindings } from "../dist/application/legacy-source-binding-audit.js";

function stored(routes=[]){return{
  revision:1,updatedAt:"2026-08-27T08:00:00.000Z",
  config:{
    sources:[{connectionId:"source-drive",displayName:"Drive",kind:"google_drive",rootRef:"root",enabled:true,disposition:{mode:"database_only",leavePartialUntouched:true,leaveBlockedUntouched:true}}],
    lanes:[{laneId:"lane-main",connectionId:"source-drive",displayName:"Main",folderRef:"folder-legacy",folderPath:"/Main",interpretation:{kind:"flat"},enabled:true}],
    postingProfiles:[],copyProfiles:[],routes,activationCursors:[]
  },schedulePolicies:{},planningPolicy:{contentOrder:"FILENAME_NUMERIC_PREFIX",lateArrival:"NEXT_AVAILABLE_SLOT",overflow:"BACKLOG_NEXT_DAY"}
};}
const legacy={binding:{bindingId:"binding-old",accountId:"instagram_demo",source:"google_drive",folderId:"folder-legacy",folderPath:"Drive / Main",interpretSubstructure:false,enabled:true},createdAt:"2026-08-26T08:00:00.000Z",updatedAt:"2026-08-26T08:00:00.000Z"};

test("legacy binding is NEEDS_MIGRATION until canonical route exists",()=>{
  const audit=auditLegacySourceBindings(stored(),[legacy]);
  assert.equal(audit.needsMigration,1);
  assert.equal(audit.items[0].status,"NEEDS_MIGRATION");
  assert.deepEqual(audit.items[0].matchingLaneIds,["lane-main"]);
  assert.deepEqual(audit.items[0].matchingRouteIds,[]);
});

test("legacy binding becomes audit-only MIGRATED when lane and route cover same relation",()=>{
  const route={routeId:"route-main",displayName:"Main -> IG",laneId:"lane-main",accountId:"instagram_demo",platform:"instagram",postingProfileId:"ig-normal",copyProfileId:"copy",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true};
  const audit=auditLegacySourceBindings(stored([route]),[legacy]);
  assert.equal(audit.migrated,1);
  assert.equal(audit.needsMigration,0);
  assert.deepEqual(audit.items[0].matchingRouteIds,["route-main"]);
});

test("disabled historical binding remains visible but never needs migration",()=>{
  const disabled={...legacy,binding:{...legacy.binding,enabled:false}};
  const audit=auditLegacySourceBindings(stored(),[disabled]);
  assert.equal(audit.disabled,1);
  assert.equal(audit.needsMigration,0);
  assert.equal(audit.items[0].status,"DISABLED");
});
