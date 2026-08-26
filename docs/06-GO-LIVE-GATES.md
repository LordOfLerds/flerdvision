# 06 — Go-live gates

Customer publishing remains disabled until every mandatory gate is green.

## Engineering
- [ ] Domain/unit suite green.
- [ ] Adapter contract tests green.
- [ ] Reboot/crash recovery proven.
- [ ] `PUBLISH_UNCERTAIN` scenario proven end-to-end.
- [ ] Duplicate source and duplicate retry tests green.
- [ ] Account identity guard proven.
- [ ] Publish hard gate proven to block non-allowlisted accounts.

## UI/platform
- [ ] Instagram normal-post pre-publish flow stable.
- [ ] TikTok pre-publish flow stable.
- [ ] YouTube Shorts pre-publish flow stable.
- [ ] Trial Reel capability explicitly measured per intended account; no assumptions.
- [ ] Unknown UI state fails closed.

## Operations
- [ ] Human can open the affected browser session securely.
- [ ] Auth/2FA incident path rehearsed.
- [ ] Bot/notification incident path rehearsed.
- [ ] Daily readiness/completion reports correct.
- [ ] Kill switch rehearsed.
- [ ] AI repair evidence redaction reviewed with representative incidents.
- [ ] AI repair path proven unable to access social credentials or bypass PUBLISH_UNCERTAIN/auth/policy gates.

## Data/security
- [ ] No secrets/profile data in Git.
- [ ] Runtime evidence access controlled.
- [ ] Customer media cache lifecycle defined.
- [ ] Backups restore DB state without browser secrets leaking into general backups.

## Test account
- [ ] Prepare-only live E2E passes repeatedly.
- [ ] Private zero-viewer E2E passes if privacy conditions can actually be guaranteed.

## Release
- [ ] Canary scope explicitly approved.
- [ ] Rollback/disable procedure tested.
- [ ] Release SHA recorded in every publish attempt.
