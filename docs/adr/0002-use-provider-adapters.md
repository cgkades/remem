# ADR 0002: Use Provider Adapters

- Status: Accepted
- Date: 2026-09-01

## Context

Memory systems expose incompatible search, metadata, scope, score, and mutation semantics. Letting
those SDK types enter the planner or injector would couple the architecture to the first backend.

## Decision

Every backend implements a small capability-driven `MemoryProvider` contract and returns normalized
catalog entries, records, provenance, and retrieval signals. Orchestration policy remains in the
core.

## Consequences

- Providers can fail and evolve independently.
- Capability negotiation is explicit.
- Some provider-specific features require metadata extensions or optional interfaces.
- Adapter conformance tests are necessary.
- Normalized scores cannot erase provider-specific uncertainty.
