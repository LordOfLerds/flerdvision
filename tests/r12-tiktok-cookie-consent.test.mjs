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
  const idx = source.indexOf("private async dismissBenignOverlay");
  const block = source.slice(idx, idx + 4500);
  const declineFirst = block.indexOf("decline.has(value)");
  const allowSecond = block.indexOf("allow.has(value)");
  assert.ok(declineFirst > 0 && declineFirst < allowSecond, "declining must be preferred");
});

test("the scan reaches the TikTok cookie banner host and its shadow root", () => {
  // TikTok has historically rendered the banner as <tiktok-cookie-banner> with a shadow root
  // instead of a [role=dialog]; the dialog-only scan would never see it.
  assert.match(source, /querySelector\('tiktok-cookie-banner'\)/);
  assert.match(source, /container\.shadowRoot \?\? container/);
});

test("the dialog scan stays narrow: dialog roles plus two named hosts", () => {
  assert.match(source, /querySelectorAll\('\[role="dialog"\], \[role="alertdialog"\]'\)/);
  // Named additions only -- the cookie banner element and the product-tour tooltip. No wildcards.
  assert.match(source, /tiktok-cookie-banner/);
  assert.match(source, /react-joyride__tooltip, \[data-test-id="tooltip"\]/);
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

test("a leftover-draft restore prompt is discarded, never continued", async () => {
  const { DRAFT_RESTORE_MARKERS, DISCARD_CONFIRM_LABELS, OVERLAY_DISMISS_FORBIDDEN_WORDS } = await import("../dist/adapters/browser/autonomous-surface-explorer.js");
  // Live 2026-08-31: TikTok silently refuses new uploads while "…wurde nicht gespeichert" is up.
  assert.ok(DRAFT_RESTORE_MARKERS.some((m) => "ein video, das du bearbeitet hast, wurde nicht gespeichert.".includes(m)));
  // Continuing the old draft would post the wrong media: only discard labels may be clicked, and
  // none of them is flow/publish vocabulary.
  for (const label of DISCARD_CONFIRM_LABELS) {
    assert.ok(!OVERLAY_DISMISS_FORBIDDEN_WORDS.some((w) => w.toLocaleLowerCase("en-US") === label.toLocaleLowerCase("en-US")));
  }
  const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  assert.match(source, /await dismissDraftRestore\(this\.session, journal\)/);
  assert.match(source, /platform === "tiktok" \? 90_000 : 2500/);
});

test("only a visible restore prompt is answered, never a mounted-but-hidden one", () => {
  const source = readFileSync(new URL("../src/adapters/browser/autonomous-surface-explorer.ts", import.meta.url).pathname, "utf8");
  const idx = source.indexOf("export async function dismissDraftRestore");
  const block = source.slice(idx, idx + 2900);
  // Acting on a hidden dialog clicked discard on a healthy upload surface and tore the file
  // input out from under the upload step.
  assert.match(block, /role="dialog"\], \[role="alertdialog"\]/);
  assert.match(block, /rect\.width > 0 && rect\.height > 0/);
});
