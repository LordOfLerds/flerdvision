import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonDistributionConfigurationStore } from "../dist/adapters/distribution/json-config-store.js";
import { SqliteControlPlaneStore } from "../dist/adapters/storage/sqlite.js";
import { SetupDistributionOnboardingService } from "../dist/application/setup-distribution-onboarding.js";
import { SetupChannelRegistrationService } from "../dist/application/setup-channel-registration.js";
import { PublishingProgramManagementService } from "../dist/application/publishing-program-management.js";

const actor={type:"test",id:"route-first-onboarding"};

test("source lane and social channel stay independent until PublishingProgram creates canonical route",()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-route-first-"));
  try{
    const config=new JsonDistributionConfigurationStore(join(root,"distribution.json"));
    const control=new SqliteControlPlaneStore(join(root,"runtime.sqlite"));
    try{
      const laneResult=new SetupDistributionOnboardingService(config).registerLane({
        provider:{kind:"google_drive",rootRef:"drive-root",displayName:"Demo Drive"},
        folderRef:"folder-main",folderPath:"Demo / Main",interpretSubstructure:false,activationMode:"NEW_ONLY",now:"2026-08-27T08:00:00.000Z"
      });
      assert.equal(laneResult.created,true);
      assert.equal(config.load().config.routes.length,0,"source onboarding cannot create a target route implicitly");

      const registration=new SetupChannelRegistrationService(control).registerFromDiscovery({
        result:{platform:"instagram",discoveredAt:"2026-08-27T08:01:00.000Z",channels:[{channelKey:"ig-main",handle:"@demo_account",label:"Demo"}]},
        channelKey:"ig-main",checkId:"check-route-first",now:"2026-08-27T08:01:00.000Z",actor
      });
      assert.equal(control.listSocialAccounts().length,1);
      assert.equal(control.listChannelSourceBindings().length,0,"channel registration must never write legacy folder/account binding state");

      const current=config.load();
      config.save({
        updatedAt:"2026-08-27T08:02:00.000Z",
        config:{
          ...current.config,
          postingProfiles:[{postingProfileId:"ig-normal",displayName:"IG Normal",platform:"instagram",format:"reel",commentsEnabled:true,shareToFeed:true,crosspostFacebook:false,enabled:true}],
          copyProfiles:[{copyProfileId:"copy-default",displayName:"Default",versionId:"v1",strategy:"static",enabled:true}]
        },
        schedulePolicies:current.schedulePolicies,
        planningPolicy:current.planningPolicy,
        ...(current.operatingCalendars?{operatingCalendars:current.operatingCalendars}:{}),
        ...(current.runtimePolicy?{runtimePolicy:current.runtimePolicy}:{})
      },current.revision);

      const programs=new PublishingProgramManagementService(config,()=>control.listSocialAccounts().map(record=>record.account));
      const preview=programs.preview({laneId:laneResult.lane.laneId,businessDate:"2026-08-28",targets:[{
        accountId:registration.accountId,postingProfileId:"ig-normal",copyProfileId:"copy-default",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true
      }]});
      assert.equal(preview.routes.length,1);
      assert.equal(preview.routes[0].laneId,laneResult.lane.laneId);
      assert.equal(preview.routes[0].accountId,registration.accountId);
      programs.apply({laneId:laneResult.lane.laneId,businessDate:"2026-08-28",targets:[{
        accountId:registration.accountId,postingProfileId:"ig-normal",copyProfileId:"copy-default",schedulePolicyId:"default",requirement:"REQUIRED",enabled:true
      }]},preview.currentRevision,"2026-08-27T08:03:00.000Z");
      assert.equal(config.load().config.routes.length,1,"only PublishingProgram may create source -> account distribution relation");
      assert.equal(control.listChannelSourceBindings().length,0,"legacy binding state stays empty after canonical route creation");
    }finally{control.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("legacy bindSource compatibility call is fail-closed and side-effect free",()=>{
  const root=mkdtempSync(join(tmpdir(),"flerdvision-binding-guard-"));
  try{
    const control=new SqliteControlPlaneStore(join(root,"runtime.sqlite"));
    try{
      const service=new SetupChannelRegistrationService(control);
      assert.throws(()=>service.bindSource({accountId:"anything",folderId:"anything"}),/LEGACY_SOURCE_BINDING_DISABLED/);
      assert.deepEqual(control.listChannelSourceBindings(),[]);
    }finally{control.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
