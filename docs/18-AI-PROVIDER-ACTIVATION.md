# AI provider activation

The social publisher remains UI-native and does not require Instagram/TikTok/YouTube APIs. AI repair is a separate adapter and can be disabled without affecting deterministic publishing, verification, operations, or recovery.

## Target modes

`AI_REPAIR_MODE` is conceptually one of:

- `disabled` — default and safest.
- `claude_subscription_cli` — pilot/development through an authenticated Claude Code subscription session.
- `codex_chatgpt_cli` — pilot/development through an authenticated Codex/ChatGPT session.
- `anthropic_api` — unattended service mode using a separately billed Anthropic API credential.
- `openai_api` — unattended service mode using a separately billed OpenAI API credential.

The repo deliberately keeps the provider behind a structured wrapper command. The wrapper receives sanitized JSON on stdin and must return the W7 JSON contract on stdout. It never receives browser profiles or social credentials.

## Recommended rollout

### W8 / private pilot
Use a subscription CLI only if an operator already owns the plan and accepts its usage limits. This minimizes setup while real selector/incidents are still low-volume.

For Claude, Pro/Max include Claude Code. If an `ANTHROPIC_API_KEY` is present, Claude Code may use API billing instead of included subscription usage, so the server environment must be deliberate rather than mixing both accidentally.

For Codex, ChatGPT login can be used in the CLI; plan limits/credits depend on the ChatGPT plan and current Codex pricing.

### Shared unattended production
Prefer a dedicated provider/service credential with explicit budget limits, billing alerts and revocation/rotation. A personal consumer OAuth session should not be the sole dependency for a shared production repair system.

This is also consistent with Anthropic's current guidance that shared production automation should use Claude Platform/API for predictable pay-as-you-go billing. The previously announced separate monthly Agent SDK credit for subscription plans was paused in June 2026; do not design production economics around it.

## Access boundaries

The provider process may receive only:
- sanitized W7 evidence bundle,
- repo worktree path for the isolated repair branch,
- provider authentication needed by the wrapper,
- fixed W7 output contract.

It must not receive:
- Instagram/TikTok/YouTube passwords,
- browser profile directories/cookies,
- customer raw media unless explicitly sanitized/approved,
- kill-switch authority,
- manual-not-published authority,
- final publish capability.

## Preflight

Example config:

```json
{
  "mode": "disabled",
  "enabled": false,
  "wrapperCommand": "",
  "wrapperArgs": [],
  "timeoutMs": 120000
}
```

Validate host/provider wiring:

```bash
npm run ai-provider -- --config config/ai-provider.example.json
```

API modes additionally require the matching provider key to exist in the process environment. Subscription modes require the wrapper/CLI to already be authenticated on the private worker host.

## Cost control

AI repair is event-driven, not continuously polling the model. Deterministic incident classification runs first. The model is called only for eligible technical incidents after redaction. That keeps usage bounded and ensures a provider outage never stops ordinary deterministic operations.
