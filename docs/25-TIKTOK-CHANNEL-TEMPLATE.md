# TikTok Channel Template — Private Test Account

Status: template for the first TikTok acceptance on `rebuild/headless-agentic-v1`. The
acceptance itself follows `docs/23-CLAUDE-REAL-ACCOUNT-ACCEPTANCE.md` with `--channel
tiktok-flerdvision-test` in place of the Instagram channel.

## Channel block for the host-local `flerdvision.json`

Add this to `channels` (replace `handle` with the exact handle of the freshly created private
test account; the `key` is stable and becomes part of every derived ID):

```json
{
  "key": "tiktok-flerdvision-test",
  "name": "Flerdvision TikTok Test",
  "platform": "tiktok",
  "handle": "REPLACE_WITH_EXACT_TEST_HANDLE",
  "formats": [
    {
      "type": "tiktok",
      "times": ["13:00"],
      "sourceMatch": ["tiktok"],
      "captionTemplate": "{filenameText} {filenameHashtags}\n\n[FV:{contentId}]",
      "hashtags": [],
      "verificationMarker": true,
      "requirement": "REQUIRED",
      "settings": {
        "visibility": "only_you",
        "commentsEnabled": false,
        "duetEnabled": false,
        "stitchEnabled": false
      }
    }
  ]
}
```

## Non-negotiable settings

- `"visibility": "only_you"` is **mandatory and must be written explicitly**. The compiler
  defaults an unset TikTok visibility to `everyone`; the zero-viewer gate
  (`assertZeroViewerVisibility` in `src/adapters/runtime/workspace-private-e2e.ts`) hard-stops
  any private E2E whose posting profile is not `only_you`, because a TikTok post left on its
  default publishes publicly even on a private account. Writing it explicitly also records
  spec provenance (`explicitSettings`), so the surface flow must find and prove the visibility
  control instead of tolerating its absence.
- `duetEnabled`/`stitchEnabled`/`commentsEnabled` are set to `false` for the test account to
  minimize interaction surface; each explicitly written setting must be found and read back on
  the live compose page (`AutonomousSurfaceSettings`), otherwise the run fails closed.
- `requirement: "REQUIRED"` makes the route mandatory for qualification; use `"OPTIONAL"` only
  when a missing TikTok source folder must not block the rest of the workspace.
- `sourceMatch: ["tiktok"]` selects the Drive/local source folder whose name matches; the test
  folder must contain harmless test media only.
- `verificationMarker: true` plus the `[FV:{contentId}]` caption tail is what deterministic
  verification greps for; do not remove it.
- `captionTemplate` uses the two filename variables, not the raw `{filename}`: the caption is
  written into the Drive filename and TikTok is the platform that carries the hashtags. See
  "Caption from the filename" below.

## Caption from the filename

The operator writes the caption into the Drive filename, hashtags included, and numbers the
files so they sort into posting order:

```text
07_Testwelle Mi 1830 TikTok #flerdvision #test.mp4
```

`src/adapters/publish/workspace-payload-resolver.ts` (`filenameParts`) splits that one name into
two template variables; `{filename}` stays available but carries the sort prefix and the
extension and must not be posted:

| variable             | value for the file above            |
|----------------------|-------------------------------------|
| `{filenameText}`     | `Testwelle Mi 1830 TikTok`          |
| `{filenameHashtags}` | `#flerdvision #test`                |

Rules: a leading `NN_` (one to three digits plus underscore) is stripped as ordering, the
extension is stripped, every `#tag` anywhere in the name is moved out of the wording, whitespace
is collapsed. Nothing else is rewritten -- dashes and casing are the operator's wording.

TikTok therefore uses `{filenameText} {filenameHashtags}`; Instagram (`docs/27`) uses only
`{filenameText}`, so one Drive file serves both. A file without hashtags leaves an empty
`{filenameHashtags}` and a trailing space before the marker, which the platform ignores.
`tests/r16-filename-template-payloads.test.mjs` renders the shipped example through the real
compiler and resolver and pins this split.

## Zero-viewer contract for the test account

Before the one-shot private final action, the operator must attest (per `privateTest` in the
spec and the run-time attestation): account set to private, zero approved followers, contacts
sync off, cross-posting off, test media only. The `only_you` per-post visibility is enforced on
top of that by the gate above — both must hold.

## Known open live-calibration items

Grep for `TIKTOK-LIVE-CALIBRATION` in `src/`. As of this template: the identity probe selector
in `src/application/headless-login.ts` (self-scoped probe page + live selector unproven) and the
exact cookie-banner structure in `src/adapters/browser/autonomous-surface-explorer.ts`. Both
fail closed until calibrated against the live logged-in TikTok surface during the first
acceptance; they are not permission to invent selectors offline.
