# CLAUDE.md

This repository is safety-critical automation around real social accounts.

Before editing, read `AGENTS.md` and the architecture docs. Preserve ports/adapters boundaries. Do not shortcut verification, do not infer creator/account routing from content semantics when deterministic configuration is available, and do not turn browser success messages into source of truth without evidence.

When repairing a UI adapter:
1. reproduce with fixtures/trace,
2. patch on a branch,
3. add a regression test,
4. run dry-run/pre-publish E2E,
5. only then canary.

Never expose secrets or browser profile material to prompts. Incident bundles should be redacted before AI diagnosis.
