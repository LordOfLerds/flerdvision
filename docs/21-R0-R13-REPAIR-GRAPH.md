# R0-R13 repair graph

This document is the canonical repair plan after the W8A/W9 setup review. It supplements the historical wave documents; it does not rewrite their safety invariants.

## Non-negotiable workflow check

A feature is incomplete until its forward and reverse path are explicit across:

`Source -> Route -> Plan -> UI -> Publish -> Verify -> SourceDisposition -> Notification -> OperatorRecovery`.

Every implementation change must answer: domain node/edge, forward workflow, reverse traceability, source/Drive effect, planner effect, route/profile impact, state transitions, UI exposure, notification impact, failure mode, recovery, double-post safety, regression test, migration impact, and host requalification impact.

## Repair stages

- R0 LIVE FREEZE — no customer automation while the repair graph is incomplete.
- R1 DOMAIN — SourceConnection, SourceLane, PostingProfile, CopyProfile, DistributionRoute, DeliveryRequirement.
- R2 SOURCE LIFECYCLE — SourceActivationCursor, AssetReadyGate, ContentAsset, SourceDispositionPolicy, DeliveryAggregate/backlog semantics.
- R3 PLANNER — ContentOrderPolicy, LateArrivalPolicy, overflow, DailyPlan, PlanGap, Delivery, deterministic PublicationIntent generation.
- R4 CONTROL UI — Today, Content, Sources, Channels, Routes, Profiles, Schedule, Settings. The linear setup wizard becomes onboarding only.
- R5 PLATFORM AUTOMATION — Playwright adapter, calibration recorder, versioned surface contracts, Instagram/TikTok variants, verification and cleanup contracts.
- R6 ROUTE TEST LAB — generated from configured routes; session, identity, prepare-only, secret-live, verify, cleanup.
- R7 RUNTIME SUPERVISOR — source watch, readiness, planning, preflight, publish, verify, reconcile, disposition.
- R8 OPERATIONS + NOTIFICATIONS — morning readiness, pre-slot warnings, incident escalation, completion, deep links.
- R9 EXTRA WORKFLOWS — story policy, metrics/tracker, recurring jobs.
- R10 LUCA MAC.
- R11 FABIAN MAC.
- R12 VPS STAGING.
- R13 CUSTOMER CANARY.

## Drive/source principles

Drive is a source, not the workflow database. Default disposition is `database_only`; optional adapters may write metadata or move only fully complete assets when explicitly configured. A new lane requires an activation cursor so historical files cannot silently become new work. An asset is not READY until stable bytes and readable media are evidenced.

## Distribution cardinality

The legacy rule "one account watches exactly one folder" is not the target model. Target cardinality is many-to-many through DistributionRoute:

- one SourceLane may feed many social channels;
- one social channel may receive many SourceLanes;
- each route selects PostingProfile, CopyProfile, SchedulePolicy and REQUIRED/OPTIONAL semantics.

## Daily plan principles

The DailyPlan is the operator-visible contract before posting. Missing content is a `PlanGap`; overflow is backlog; late arrivals follow an explicit policy; an account/slot collision is blocked rather than resolved by route iteration order.

## UI target

Primary navigation becomes: Today, Content, Sources, Channels, Routes, Profiles, Schedule, Test Lab, Incidents, Activity, Settings. Setup remains an onboarding flow only.

## Notification target

Normal success is quiet. Action-required, warning and critical states notify according to NotificationPolicy. Every notification identifies impact and safe next action and deep-links to the canonical UI object. PUBLISH_UNCERTAIN remains reconciliation-only.
