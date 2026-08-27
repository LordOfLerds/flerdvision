import test from "node:test";
import assert from "node:assert/strict";
import { calibratedProfileVerificationSpecFor, parseProfileVerificationSpecFile } from "../dist/adapters/verify/profile-spec-config.js";

function spec(overrides={}){
  return{
    specId:"ig-profile",platform:"instagram",calibrationStatus:"CALIBRATED",calibratedAt:"2026-08-27T15:00:00.000Z",calibratedBy:"operator",
    spec:{platform:"instagram",bootstrapUrl:"https://www.instagram.com/",profileUrlTemplate:"https://www.instagram.com/{handle}/",profileReadyLocators:[{kind:"css",value:"main"}],postMatchLocators:[{kind:"css",value:"a[href*='/reel/']"}],permalinkAttribute:"href"},
    ...overrides
  };
}

test("account-specific verification contract wins over generic",()=>{
  const file=parseProfileVerificationSpecFile({schemaVersion:1,specs:[spec(),spec({specId:"ig-main",accountId:"ig-main"})]});
  assert.equal(calibratedProfileVerificationSpecFor(file,"ig-main","instagram")?.specId,"ig-main");
  assert.equal(calibratedProfileVerificationSpecFor(file,"ig-other","instagram")?.specId,"ig-profile");
});

test("calibrated verification contracts reject placeholders",()=>{
  assert.throws(()=>parseProfileVerificationSpecFile({schemaVersion:1,specs:[spec({spec:{platform:"instagram",bootstrapUrl:"https://www.instagram.com/",profileUrlTemplate:"https://www.instagram.com/{handle}/",profileReadyLocators:[{kind:"css",value:"__CALIBRATE__"}],postMatchLocators:[{kind:"css",value:"a[href*='/reel/']"}]}})]}),/calibration placeholder/);
});

test("unverified verification templates remain selectable only after calibration",()=>{
  const file=parseProfileVerificationSpecFile({schemaVersion:1,specs:[{specId:"tt-template",platform:"tiktok",calibrationStatus:"UNVERIFIED",spec:{platform:"tiktok",bootstrapUrl:"https://www.tiktok.com/",profileUrlTemplate:"https://www.tiktok.com/@{handle}",profileReadyLocators:[{kind:"css",value:"__CALIBRATE__"}],postMatchLocators:[{kind:"css",value:"__CALIBRATE__"}]}}]});
  assert.equal(calibratedProfileVerificationSpecFor(file,"tt-main","tiktok"),null);
});
