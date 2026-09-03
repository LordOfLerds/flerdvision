# Verification adapters

Implementation wave W5.

The initial target is composite evidence: profile/post evidence plus UI receipt or manual confirmation. Confirmation is deliberately modular so today's bot/checkmark mechanism can be retained, replaced or combined later.

## How a post is matched

Two matching rules, one per verification contract:

- **Marker** (`postMatchLocators`): only for routes that still set `verificationMarker: true`.
  The caption ends in `[FV:{contentId}]` and a text locator finds it.
- **Caption equality** (`captionMatch`): the production default. The collector opens the
  account's own newest posts, reads copy, publish time and media duration off each post page and
  accepts exactly one post that was published inside `[finalActionAt - 2 min, now]` and whose
  copy, whitespace-collapsed and case-preserved, equals the copy the run posted. The expected
  copy comes from the same payload resolver the publisher used (`PayloadExpectedPublicationCopy`),
  never from the page.

Everything ambiguous is `inconclusive_profile_check`, which keeps the intent uncertain and can
never accumulate into `SAFE_TO_RETRY`. Only posts with a readable publish time that are provably
older than the window count as absence.
