# YouTube Channel Template — Shorts acceptance preparation

Status: PREPARATION. This documents the exact `flerdvision.json` channel block for a YouTube
Shorts channel and the known unknowns of the Studio upload dialog. Everything marked
**LIVE CALIBRATION** requires a real signed-in Studio session and must not be guessed in code
(see `docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md` §9: no invented selectors).

## 1. Channel block for the canonical spec

The compiler accepts exactly one YouTube format type: **`short`**
(`src/domain/workspace-spec.ts` `format()`: youtube → `["short"]`;
`src/application/workspace-spec-compiler.ts` `postingProfile()` rejects everything else).

```json
{
  "key": "youtube-flerdvision",
  "name": "Flerdvision YouTube",
  "platform": "youtube",
  "handle": "flerdvision",
  "formats": [
    {
      "type": "short",
      "times": ["14:00"],
      "sourceMatch": ["youtube", "shorts"],
      "titleTemplate": "{filenameText}",
      "descriptionTemplate": "{filenameHashtags}",
      "hashtags": [],
      "verificationMarker": false,
      "requirement": "REQUIRED",
      "settings": {
        "visibility": "private",
        "madeForKids": false
      }
    }
  ]
}
```

Rules the code enforces:

- `settings.visibility` accepts only `"private" | "unlisted" | "public"` for youtube
  (`workspace-spec.ts` `settings()`). **For the acceptance it MUST be `"private"`** — both
  zero-viewer gates hard-fail otherwise:
  - `src/application/headless-demo.ts` (`ZERO_VIEWER_VISIBILITY = { youtube: "private" }`)
    refuses `--private-publish` when any format of the selected channel is not `"private"`,
    including "unset (platform default)";
  - `src/adapters/runtime/workspace-private-e2e.ts` `assertZeroViewerVisibility()` refuses to
    even start a private E2E run when the compiled posting profile's visibility is not
    `"private"`. The compiler default for an unset youtube visibility is `"public"` — never
    leave it unset.
- `settings.madeForKids` is **mandatory**. Studio blocks its whole upload wizard on the
  audience question ("Wurde dieses Video speziell für Kinder erstellt? (erforderlich)"); it is a
  legal statement about the content, so the code has no default: the explorer answers the radio
  from this value and proves the answer by readback, and `AutonomousSurfaceSettings.enrich()`
  stops the run with "YouTube requires the made-for-kids declaration" when it is unset
  (`tests/r15-youtube-audience.test.mjs`).
- `handle` is the channel's `@handle` without the `@` (normalized by `normalizeSocialHandle`).
- YouTube intents require a **title**. The caption lives in the Drive filename
  (`07_Testwelle Mi 1830 TikTok #flerdvision #test.mp4`), and the resolver splits it into
  `{filenameText}` (`Testwelle Mi 1830 TikTok`: sort prefix, extension and hashtags removed) and
  `{filenameHashtags}` (`#flerdvision #test`) -- see `docs/25-TIKTOK-CHANNEL-TEMPLATE.md`,
  "Caption from the filename". The template above posts the wording as the title and keeps the
  hashtags in `descriptionTemplate`. The compiler still defaults an unset `titleTemplate` to the
  raw `{filename}`, which carries the sort prefix and the extension: always set it explicitly.
  `descriptionTemplate` is accepted, compiled into the copy payload and rendered by the resolver,
  but the explorer fills **no Studio description field today** (see §4) -- the hashtags reach
  YouTube only once that step exists. Do not move them into the title to work around it.
- `settings.commentsEnabled` is accepted by the validator for youtube but is **not replayed**:
  `platformSettingOrder()` in `src/application/autonomous-surface-contract.ts` returns only
  `["AUDIENCE", "VISIBILITY"]` for youtube and `AutonomousSurfaceSettings.enrich()` ensures
  exactly those two. Do not set it and expect an effect; leave comments at the Studio default.
- `verificationMarker` appends `[FV:{contentId}]` to the **caption** template only, which
  youtube does not have; leave it at its default `false`. YouTube is verified marker-free: the
  verifier opens the channel's newest shorts and requires one of them, published inside the run's
  own publish window, to carry exactly this `titleTemplate` as its title — see §5 for what a
  private short does and does not make visible.

## 2. Operator prerequisites (existing channel)

- Use the **existing** channel; do not create a new one during the acceptance.
- The Google login runs through the normal login flow:
  `npm run flerdvision -- login --spec "$FLERDVISION_SPEC" --channel youtube-flerdvision`.
  The human completes Google sign-in including 2FA/passkey in the opened profile browser; the
  login loop now waits on the Google authenticated-session cookies
  (`SAPISID`/`__Secure-1PAPISID`/`__Secure-3PAPISID`/`__Secure-1PSID`, see
  `src/application/headless-login.ts` `sessionCookieNames()`) and touches nothing until one
  exists. Use `--login-timeout <minutes>` if 2FA takes longer than 15 minutes.
- **Multi-channel Google accounts (brand channels):** Studio opens the last-used channel. If the
  Google account owns several channels, the human must switch to the exact target channel during
  login. The identity probe must then prove the exact channel — see §6.
- **Audience ("made for kids"):** declare it in the spec (`settings.madeForKids`, §1). The
  explorer carries an `AUDIENCE` step that clicks exactly the declared answer on the Details
  step's required radio and reads it back; a channel-level Studio default is no longer needed,
  and an unset value stops the run before any upload.
- **Daily upload limit:** an unverified channel gets a handful of uploads per day, and every
  qualification run consumes one. Studio does not report the exhausted limit as an error; it
  writes "Tägliches Upload-Limit erreicht" into the dialog and greys the details form. The run
  now stops with `Platform refused this account: "Tägliches Upload-Limit erreicht"`
  (`src/adapters/browser/platform-refusal.ts`); wait 24 h or verify the channel at
  `youtube.com/verify`, and run qualifications sparingly.

## 3. Studio upload dialog — expected step chain vs. code

The Studio upload dialog is a four-step wizard:

```text
(file picked) → Details → Video elements → Checks → Visibility → final button
                Details → Videoelemente → Prüfung → Sichtbarkeit
```

That is **three "Next"/"Weiter" clicks** between the title field and the visibility step. The
explorer (`src/adapters/browser/autonomous-surface-explorer.ts`) models this generically:

- `nextLocators()` contains exact `button`/`text` matches for `"Next"`, `"Weiter"`,
  `"Continue"`, `"Fortfahren"` — the Studio step button label ("Weiter"/"Next") is covered.
- **But the NEXT chain has no home in the current youtube path.** The `NEXT_1..NEXT_3` loop
  (exactly enough clicks for Studio's three steps) runs only **while the title field is still
  missing**. In Studio the title is on the FIRST step, so no Weiter is ever clicked; the
  explorer then immediately hunts `FINAL_ACTION` ("Speichern"/"Veröffentlichen"), which Studio
  renders only on the LAST wizard step — the Details step's bottom-right button is "Weiter".
  Unless Studio keeps the final button visible in the DOM across steps (unverified), the
  required `FINAL_ACTION` step times out and the youtube exploration fails there. The settings
  enrichment (`AutonomousSurfaceSettings.enrich`, called after `discoverAndPrepare` in
  `src/application/autonomous-surface-qualification.ts`) also clicks no "Weiter": it hunts the
  visibility control plus one `ADVANCED_SETTINGS` disclosure. **LIVE CALIBRATION:** capture the
  dialog DOM per step to decide where a Studio-specific Weiter chain must be inserted
  (between TITLE and FINAL_ACTION, and/or before VISIBILITY) — the labels are already in
  `nextLocators()`, the sequencing is what is missing.
- `finalLocators()` for youtube: exact `"Publish"`, `"Veröffentlichen"`, `"Save"`,
  `"Speichern"`. Studio's final button is visibility-dependent: **"Speichern"/"Save" when
  private or unlisted is selected**, "Veröffentlichen"/"Publish" for public, "Planen"/"Schedule"
  for scheduled. For the private acceptance the expected label is "Speichern", which the code
  already carries as an exact match — no change needed. If live Studio shows a different label
  (e.g. "Fertig"/"Done" variants have existed), extend `finalLocators` with the **exact**
  observed accessible name only, never a substring match (final-action locators are the
  click-refusal boundary and must stay exact).

## 4. Known gaps that need LIVE CALIBRATION (do not code blind)

1. **Opening chain is one click short.** `openingSteps()` for youtube is a single required
   `OPEN_UPLOAD` step whose candidates mix the create button ("Create"/"Erstellen") and the menu
   entry ("Upload videos"/"Videos hochladen"). The first candidate that exists wins — on the
   Studio dashboard that is the create button, after which the **menu item is never clicked**.
   The fallback `uploadRevealStep()` does not carry "Videos hochladen" as an exact name either.
   Either the file input must already be present after the create click (unverified) or a second
   step (create → upload-menu-item) is required. Confirm roles/names on live Studio
   (`#create-icon` button, menu item accessible name) before changing the step list.
   An alternative worth testing live: bootstrapping the explorer directly into the upload dialog
   via a Studio upload deep link, which would remove the menu dependency entirely.
2. **Title field.** `titleLocators()`: exact textbox names "Title"/"Titel", contains-labels, and
   `#textbox[contenteditable="true"]`. Studio's title is a contenteditable div with
   `id="textbox"` — but Studio reuses `id="textbox"` for the **description** field too
   (duplicate DOM ids). `querySelector` order makes this land on the title today; that is
   incidental, not proven. Verify the accessible name of the real title field (observed
   historically as "Titel hinzufügen…"/"Add a title…" variants) and prefer it.
3. **Audience radio** — resolved: the `AUDIENCE` step answers it from `settings.madeForKids`
   with readback proof (see §1/§2). The description field remains unfilled (see §1).
4. **Visibility radio.** `visibilityControlLocators()`/`visibilityLabels()` in
   `src/adapters/browser/autonomous-surface-settings.ts` know "Private"/"Privat" and generic
   combobox/radio patterns; Studio renders the visibility step as a radio group
   (`tp-yt-paper-radio-button`, name "Privat"). Whether the generic locators + `readEnum`
   readback prove the selected state on Studio's custom elements is unknown.
5. **Shorts processing time.** After upload Studio processes the video (SD first, minutes for
   HD; Shorts classification itself is derived from length/aspect). The "Checks"/"Prüfung" step
   runs copyright checks asynchronously. The explorer's fixed 3 s post-upload sleep and 60 s
   title timeout are likely fine (Details appears immediately), but the **final button can stay
   disabled until checks finish** — the prepare-only boundary only locates it, so PREPARE_ONLY
   is expected to pass; the one-shot final click during private E2E may need a bounded wait.
   Observe live before changing timeouts.
6. **Session identity probe.** `identitySelector()` for youtube
   (`a[href*="/@handle"], a[href*="/channel/"][aria-label*="handle"]`) is a guess against
   studio.youtube.com, where the account UI is an avatar button, not obviously such an anchor.
   Same for `sourceProbeSelector()` in the compiler. Expect `HEALTHY` detection to need
   recalibration against the real Studio DOM (the calibrated probe is written by
   `headless-login` on first success, so this surfaces immediately during login).

## 5. Verification gap for private Shorts (design item, not a selector)

`verificationSpecTemplate()` compiles the youtube profile check to
`https://www.youtube.com/@{handle}/shorts` with a `{contentId}` text match. A **private** video
does not appear on the public channel/Shorts page — not even for the signed-in owner. Deterministic
verification of the private acceptance post therefore cannot succeed via the compiled profile
spec; it needs a Studio-side content view (e.g. the channel's Studio content list) or another
authenticated readback. Until that exists, expect `VERIFICATION` to come back negative/uncertain
for a private short and treat it as the known blocker it is — do **not** loosen the
verification to pass, and do not flip visibility to public to make the profile page show it.

## 6. Acceptance checklist deltas vs. Instagram (docs/23)

- Channel key in all commands: `--channel youtube-flerdvision`.
- Login proof: expect the cookie gate message naming the Google cookies, then a `HEALTHY`
  session with the exact observed handle (after §4.6 calibration).
- PREPARE_ONLY: same required stage report (`BOOTSTRAP/INGEST_PLAN/QUALIFY/SCHEDULE PASS`,
  `PRIVATE_PUBLISH SKIPPED`), with the surface contract containing `UPLOAD_MEDIA`, `TITLE`
  (not CAPTION — `normalizeAutonomousSurfaceContract` requires `TITLE` for youtube),
  `VISIBILITY`, `FINAL_ACTION`.
- Private E2E: `settings.visibility: "private"` in the spec is a hard precondition (§1);
  cleanup means the human deletes the private short in Studio, then records the cleanup receipt.
