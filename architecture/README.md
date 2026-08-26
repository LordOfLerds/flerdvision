# Machine-readable architecture graph

`graph.json` is deliberately simple so humans and coding agents can traverse it without a graph database.

When changing a node or edge:
1. identify upstream producers,
2. identify downstream consumers,
3. inspect invariants touching the path,
4. update domain types/ports/state tests,
5. update relevant ADR/docs,
6. add migration/backward-compatibility handling if persisted data changes.

A future CI check may validate graph nodes against TypeScript domain contracts.
