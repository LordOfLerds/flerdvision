# Instagram Channel Template — Reel and Trial Reel

Status: template for an Instagram channel on `rebuild/headless-agentic-v1`, covering both formats
the compiler accepts for Instagram that carry a caption (`reel` and `trial_reel`; `story` is a
third accepted format but is out of scope here). The acceptance itself follows
`docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md`.

## 1. Channel block for the host-local `flerdvision.json`

Add this to `channels` (replace `handle` with the exact handle of the test account; the `key` is
stable and becomes part of every derived ID):

```json
{
  "key": "instagram-flerdvision",
  "name": "Flerdvision Instagram",
  "platform": "instagram",
  "handle": "REPLACE_WITH_EXACT_TEST_HANDLE",
  "formats": [
    {
      "type": "reel",
      "times": ["12:00", "19:00"],
      "sourceMatch": ["instagram", "reels"],
      "captionTemplate": "{filenameText}",
      "hashtags": [],
      "verificationMarker": false,
      "requirement": "REQUIRED",
      "settings": {
        "commentsEnabled": true,
        "shareToFeed": true,
        "crosspostFacebook": false
      }
    }
  ]
}
```

A second, brand-new channel that also wants `trial_reel` (see §2) is a separate channel block
with its own `key`, `handle` and Drive folder -- exactly how a fourth channel is added by someone
with no chat context (`docs/28-NEUER-KANAL.md`):

```json
{
  "key": "instagram-flerdvision-test",
  "name": "Flerdvision Instagram Test",
  "platform": "instagram",
  "handle": "REPLACE_WITH_EXACT_TEST_HANDLE",
  "formats": [
    {
      "type": "trial_reel",
      "times": ["17:00"],
      "sourceMatch": ["trial"],
      "captionTemplate": "{filenameText}",
      "hashtags": [],
      "verificationMarker": false,
      "requirement": "REQUIRED",
      "settings": {
        "commentsEnabled": true,
        "shareToFeed": true,
        "crosspostFacebook": false
      }
    }
  ]
}
```

`format.type` is the only field that differs between the two blocks above; everything else
(caption template, settings keys, `verificationMarker`) is identical, because both formats post
through the same Instagram share flow and only differ in one extra on-composer toggle (§2).

## 2. `trial_reel` — what it is and its one prerequisite

A **Trial Reel** is Instagram's own limited-audience test post: the reel is shown only to a
sample of non-followers before the creator decides to keep it public or make it a normal post.
The compiler models it as its own format (`src/domain/workspace-spec.ts` `format()`: instagram ->
`["reel", "trial_reel", "story"]`) because it needs one extra step on the composer that a normal
Reel never sees.

`AutonomousSurfaceSettings.enrich()` in `src/adapters/browser/autonomous-surface-settings.ts`
(around line 377) adds a `TRIAL_MODE` step exactly when `postingProfile.format === "trial_reel"`,
before the shared `SHARE_TO_FEED`/`CROSSPOST_FACEBOOK`/`COMMENTS` steps every non-story Instagram
format gets:

```ts
if (input.postingProfile.format === "trial_reel") push(await this.ensureBoolean({
  stepKey: "TRIAL_MODE", label: "Trial Reel mode", desired: true,
  candidates: booleanCandidates(["Trial reel", "Trial", "Test-Reel", "Test reel"]), ...
}));
```

**Prerequisite the operator must satisfy before using `trial_reel`, or the composer never offers
the toggle at all:** the Instagram account must be a **professional account** (Creator or
Business) with **Trial Reels enabled** in Instagram's own settings (Settings → Content →
Trial Reels, or wherever Instagram currently surfaces it). A personal (non-professional) account,
or a professional account that has not opted in, will not show a "Trial reel" control on the
composer; the `TRIAL_MODE` step then fails closed (`UiActionExecutionError`) instead of silently
posting a normal Reel.

## 3. Non-negotiable settings

- Instagram carries no `settings.visibility` field at all (`workspace-spec.ts` `settings()`
  throws `.visibility is not valid for instagram`) — audience for a normal Reel is controlled by
  the account being private/public, not a per-post setting. The zero-viewer contract therefore
  comes from the **account**, not the post: `privateTest` in the spec (`accountPrivate: true,
  approvedFollowers: 0, contactsSyncOff: true, crossPostingOff: true`) plus the run-time
  attestation, exactly as for the other platforms.
- `commentsEnabled`/`shareToFeed`/`crosspostFacebook` are set explicitly for the same reason as
  TikTok's booleans (`docs/25`): each explicitly written setting must be found and read back on
  the live compose surface, otherwise the run fails closed
  (`AutonomousSurfaceSettings.enrich`, `explicitSettings` provenance).
- `requirement: "REQUIRED"` makes the route mandatory for qualification; use `"OPTIONAL"` only
  when a missing Instagram source folder must not block the rest of the workspace.
- `verificationMarker: false` is the production default: the post carries no visible marker.
  Verification opens the newest reels and requires one of them, published inside the run's own
  publish window, to carry exactly this caption on the opened post page. Setting it to `true`
  restores the old `[FV:{contentId}]` caption tail and the marker matcher.
- `sourceMatch` selects the Drive/local source folder whose name matches — see
  `docs/28-NEUER-KANAL.md` for exactly how folder names are scored. `["instagram", "reels"]`
  fits a normal Reel channel; a trial channel typically wants its own folder, e.g. `["trial"]`,
  so trial and normal content never land in the same lane.

## 4. Caption from the filename

Both `reel` and `trial_reel` use only the wording half of the split, never the hashtags:
`{filenameText}` (see `docs/25-TIKTOK-CHANNEL-TEMPLATE.md`, "Caption from the filename", for the
full split rule and the shared example filename). Unlike TikTok, Instagram's caption template
does **not** append `{filenameHashtags}` — Instagram hashtags in the caption text read as spam to
many audiences, and the operator can still tag `#hashtags` inside the wording itself if they want
them in the Instagram caption; they will just also be stripped into `{filenameHashtags}` for
whichever other platform reads the same file. `tests/r16-filename-template-payloads.test.mjs`
pins that a filename carrying hashtags produces an Instagram caption without them while the same
file's TikTok caption keeps them.

## 5. Zero-viewer live-eligibility gap: `trial_reel` is PREPARE_ONLY-only

`src/domain/e2e-campaign.ts`'s `assertSecretLiveVariant` accepts only
`instagram.normal_reel.private_zero_followers` for a real one-shot private final action on
Instagram; `instagram.trial_reel.nonfollowers` throws "not eligible" (pinned by
`tests/w8-campaign.test.mjs`, "zero-viewer live eligibility is limited to normal private
Instagram Reel and TikTok Only you"). The reason is structural, not a missing feature: a Trial
Reel is shown to a sample of **non-followers by Instagram's own design**, so a private
zero-approved-followers account cannot make it a true zero-viewer post the way a normal Reel or a
TikTok `only_you` post can.

Practical consequence: qualify a `trial_reel` route through PREPARE_ONLY (three replays, surface
calibrated, no click) exactly like any other route, but do **not** attempt the one-shot real
private final action on it — the campaign gate refuses it before the click, and no config change
should try to route around that. Use a plain `reel` channel (§1, first block) for the real private
acceptance post.

## 6. Known open live-calibration items

The Instagram identity probe (`identitySelector`/`identityUrl` in
`src/application/headless-login.ts`, self-scoped to `/accounts/edit/`) and the profile-verification
deep check (`src/application/workspace-spec-compiler.ts` `verificationSpecTemplate`) are
live-calibrated against a real logged-in session as of the first private E2E acceptance. The
`TRIAL_MODE` control locator (`booleanCandidates(["Trial reel", "Trial", "Test-Reel", "Test
reel"])`, §2) is **not** independently proven against a live Trial-Reels-enabled composer — it
reuses the same generic boolean-toggle locator strategy as `SHARE_TO_FEED`/`COMMENTS` but has no
recorded live pass of its own. Fails closed until calibrated: an unmatched toggle raises
`UiActionExecutionError` rather than silently skipping the setting or posting a normal Reel.
