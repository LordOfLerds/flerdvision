# ADR 0001 — Hexagonal architecture for workflow edges

Status: Accepted

Decision: Content ingress, source acknowledgement, publishing, verification, notifications and persistence are ports with adapters.

Reason: Today's Drive layout and confirmation workflow are known to be changeable. Encoding them in scheduler/domain code would turn a small process change into a rewrite.

Consequence: More explicit interfaces up front; substantially safer replacement/testing later.
