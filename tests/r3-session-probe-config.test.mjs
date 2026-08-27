import test from "node:test";
import assert from "node:assert/strict";
import { calibratedSessionProbeFor, parseSessionProbeConfigFile } from "../dist/adapters/browser/session-probe-config.js";

const calibrated={
  schemaVersion:1,
  probes:[{
    probeId:"ig-generic",platform:"instagram",calibrationStatus:"CALIBRATED",
    calibratedAt:"2026-08-27T15:00:00.000Z",calibratedBy:"operator",
    config:{probeUrl:"https://www.instagram.com/",identitySelector:"a[href='/demo/']",authUrlIncludes:["/accounts/login"],challengeUrlIncludes:["/challenge/"],settleMs:500}
  },{
    probeId:"ig-account",platform:"instagram",accountId:"ig-main",calibrationStatus:"CALIBRATED",
    calibratedAt:"2026-08-27T15:01:00.000Z",calibratedBy:"operator",
    config:{probeUrl:"https://www.instagram.com/",identitySelector:"[data-account='demo']"}
  }]
};

test("account-specific calibrated probe wins over generic platform probe",()=>{
  const file=parseSessionProbeConfigFile(calibrated);
  assert.equal(calibratedSessionProbeFor(file,"ig-main","instagram")?.probeId,"ig-account");
  assert.equal(calibratedSessionProbeFor(file,"ig-other","instagram")?.probeId,"ig-generic");
});

test("calibrated probes reject placeholders",()=>{
  assert.throws(()=>parseSessionProbeConfigFile({schemaVersion:1,probes:[{
    probeId:"bad",platform:"tiktok",calibrationStatus:"CALIBRATED",calibratedAt:"2026-08-27T15:00:00.000Z",calibratedBy:"operator",
    config:{probeUrl:"https://www.tiktok.com/",identitySelector:"__CALIBRATE__"}
  }]}),/calibration placeholder/);
});

test("unverified templates may contain placeholders but are never selected",()=>{
  const file=parseSessionProbeConfigFile({schemaVersion:1,probes:[{
    probeId:"template",platform:"tiktok",calibrationStatus:"UNVERIFIED",
    config:{probeUrl:"https://www.tiktok.com/",identitySelector:"__CALIBRATE__"}
  }]});
  assert.equal(calibratedSessionProbeFor(file,"tt-main","tiktok"),null);
});
