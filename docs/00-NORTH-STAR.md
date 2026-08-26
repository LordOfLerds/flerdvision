# 00 — North Star

Flerdvision is a **durable publishing control plane** around normal logged-in user interfaces.

It is not a video generator and it is not a collection of Playwright scripts.

## Business flow today

The current operating model supplies finished videos, creates posting copy according to templates/SOP, publishes across assigned social accounts in defined time windows, publishes required push stories, records metrics, and reports account/platform incidents. Flerdvision must automate this workflow without baking today's folder names, notification channel or confirmation habit into the core.

## Architectural goals

1. **Replaceable edges** — content can arrive from today's Drive schema or a future source without rewriting publishing logic.
2. **Replaceable evidence** — success can be proven by profile inspection, UI receipt, manual acknowledgement or future verifier without rewriting orchestration.
3. **Durability** — crashes never lose jobs and never turn uncertainty into duplicate posts.
4. **Traceability** — source -> intent -> attempt -> evidence -> publication, and the reverse path, are queryable.
5. **Fail closed** — unknown account/UI/risk state blocks publishing.
6. **Handoffability** — a new engineer/agent can reconstruct why the system behaves as it does from Git alone.
7. **Progressive exposure** — simulation, pre-publish, private test account, canary, production are distinct modes.

## Explicit non-goals for v1

- Editing customer video files.
- Free-form autonomous AI clicking in production.
- Multi-region distributed queues.
- Kafka/Redis/Temporal unless demonstrated operational need appears.
- Automatic business decisions from visual/content semantics when routing can be configured.
