# W8 Multi-Platform Private E2E Campaign

## Goal
Prove the complete path from a demo Google Drive folder through ingress, routing, browser preparation, one-shot final action, verification and cleanup using only dedicated private test accounts and test media.

## Mandatory variant matrix

| Variant | Prepare-only | Secret live | Reason |
| --- | ---: | ---: | --- |
| Instagram normal Reel on private zero-follower test account | >=3 | yes | privacy attestation can make the first live run zero-viewer |
| Instagram Trial Reel | >=3 | no under zero-viewer campaign | Trial Reels are designed for non-follower distribution |
| TikTok Only you | >=3 | yes | per-post audience is owner-only |
| TikTok Followers | >=1 | no | UI/capability coverage only during zero-viewer campaign |
| TikTok Friends | >=1 | no | UI/capability coverage only during zero-viewer campaign |
| TikTok Everyone | >=1 | never in secret campaign | public exposure by definition |

No customer account may be used in W8.

## Drive path used by the real demo
`Flerdvision_PRIVATE_E2E_DEMO/01_TestCreator/2026-KW35/03_Mittwoch/<variant lane>/`

The folder names are adapter configuration. The domain continues to receive only source observations, format hints and campaign variant IDs.

## Complete run
1. Place unique test-only videos into each lane.
2. Read Drive recursively; verify immutable source fingerprints and content IDs.
3. Convert each lane to the corresponding W8 campaign variant and publication intent.
4. Run scheduler and account identity guard.
5. Calibrate the real UI for every variant and record capabilities.
6. Complete the required PREPARE_ONLY replay count for every variant.
7. Secret live publish A: Instagram normal Reel on a private zero-follower test account.
8. Verify the Reel on-profile, persist evidence and mark verified; then remove the test post.
9. Secret live publish B: TikTok with audience `Only you`.
10. Verify the TikTok post, persist evidence and remove it.
11. Trial Reel remains PREPARE_ONLY unless the operator explicitly accepts non-follower exposure in a separate test run.
12. Followers/Friends/Everyone TikTok variants remain PREPARE_ONLY during the zero-viewer campaign.
13. Run failure injections around the irreversible boundary and prove no duplicate final action.
14. Only after all mandatory cases are green may W8 be marked PASSED.

## Go/no-go invariant
`all mandatory prepare-only cases green AND both secret live cases verified AND cleanup verified AND failure campaign green`.
