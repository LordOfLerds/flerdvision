# 09 — Deployment topology

## MVP

```text
One stable EU/DACH server
  ├─ Control Plane
  │   ├─ scheduler
  │   ├─ SQLite WAL
  │   ├─ notification adapter
  │   └─ ops UI/CLI
  └─ Browser Worker
      ├─ Instagram profiles
      ├─ TikTok profiles
      ├─ YouTube profiles
      └─ evidence capture
```

This is intentionally cheap and operationally simple.

## Evolution path

```text
VPS Control Plane
       |
       | authenticated worker channel
       v
Austrian Browser Worker / mini-PC
       |
       +-- persistent normal-user sessions
```

The split is a deployment detail because control-plane/worker communication is behind a worker contract. Moving browser execution later does not change content ingress, scheduling or verification semantics.

## Availability philosophy

At this scale, correctness beats cluster complexity. A single durable DB + restartable worker is preferable to premature distributed systems. We add Postgres/multiple workers only after measured need.
