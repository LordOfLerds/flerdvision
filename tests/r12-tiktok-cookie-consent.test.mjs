import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BENIGN_OVERLAY_CONFIRM_LABELS,
  COOKIE_CONSENT_DECLINE_LABELS,
  OVERLAY_DISMISS_FORBIDDEN_WORDS
} from "../dist/adapters/browser/autonomous-surface-explorer.js";

// TikTok lays a cookie-consent banner over every fresh profile. It is handled by the existing
// narrow benign-overlay mechanism, extended with a decline-only vocabulary: the flow may refuse
// non-essential cookies on the operator's behalf but must never accept them, and it must never
// click anything carrying flow or publish vocabulary.

const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");

test("the decline vocabulary covers the German and English banner variants", () => {
  assert.ok(COOKIE_CONSENT_DECLINE_LABELS.includes("Alle ablehnen"));
  assert.ok(COOKIE_CONSENT_DECLINE_LABELS.includes("Decline all"));
});

test("no allowlist contains accept/consent vocabulary in any language", () => {
  const acceptWords = ["accept", "allow", "agree", "erlauben", "akzeptieren", "zustimmen", "annehmen", "einverstanden"];
  for (const label of [...COOKIE_CONSENT_DECLINE_LABELS, ...BENIGN_OVERLAY_CONFIRM_LABELS]) {
    const lower = label.toLocaleLowerCase("en-US");
    for (const word of acceptWords) {
      assert.ok(!lower.includes(word), `${label} would consent to cookies`);
    }
  }
});

test("decline labels never collide with flow or publish vocabulary", () => {
  for (const label of COOKIE_CONSENT_DECLINE_LABELS) {
    for (const word of OVERLAY_DISMISS_FORBIDDEN_WORDS) {
      assert.ok(!label.toLocaleLowerCase("en-US").includes(word.toLocaleLowerCase("en-US")),
        `${label} must never double as flow/publish vocabulary`);
    }
  }
});

test("the decline variant is preferred over the generic confirm labels", () => {
  const dismissIndex = source.indexOf("private async dismissBenignOverlay");
  const body = source.slice(dismissIndex, dismissIndex + 3000);
  const declineFind = body.indexOf("decline.has(name(el))");
  const allowFind = body.indexOf("allow.has(name(el))");
  assert.ok(declineFind > 0 && allowFind > 0, "both lookups exist");
  assert.ok(declineFind < allowFind, "decline must be searched before the generic confirm labels");
});

test("the scan reaches the TikTok cookie banner host and its shadow root", () => {
  // TikTok has historically rendered the banner as <tiktok-cookie-banner> with a shadow root
  // instead of a [role=dialog]; the dialog-only scan would never see it.
  assert.match(source, /querySelector\('tiktok-cookie-banner'\)/);
  assert.match(source, /container\.shadowRoot \?\? container/);
});

test("the dialog scan itself stays narrow: role=dialog plus the one named cookie host", () => {
  assert.match(source, /querySelectorAll\('\[role="dialog"\]'\)/);
  // No broadening to arbitrary elements: the only addition is the single named custom element.
  assert.doesNotMatch(source, /querySelectorAll\('\[role="dialog"\][^']*\*/);
});

test("containers with file inputs or text fields are still never dismissed", () => {
  assert.match(source, /scope\.querySelector\('input\[type="file"\], textarea, \[contenteditable="true"\]'\)/);
});

test("the shadow-DOM fallback click cannot escape the marked element", () => {
  // Without clickAt the fallback clicks only the previously marked button, in light or shadow DOM.
  assert.match(source, /host\.shadowRoot\.querySelector\('\[data-flerdvision-overlay\]'\)/);
});

test("the live-calibration debt on the banner structure is marked", () => {
  assert.match(source, /TIKTOK-LIVE-CALIBRATION/);
});
