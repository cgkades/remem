# ADR 0008: Manage a Default Store While Remaining an Orchestrator

- Status: Accepted
- Date: 2026-09-01
- Refines: [ADR 0001](0001-orchestrate-memory-instead-of-owning-storage.md)

## Context

An adapter-only product preserves choice but leaves a new user without a durable, searchable memory
system. Requiring users to select and operate a third-party store also makes the local-first path
harder than the remote path.

## Decision

Remem will provision and operate a local default store through an ordinary `MemoryProvider` adapter.
It is the system of record for Remem-native memories and orchestration metadata, not a mandatory sink
for external provider content. The orchestration core remains host-independent and backend-neutral;
Markdown, session, MCP, and remote providers remain first-class peers.

## Alternatives

- Remain orchestration-only with no default store: rejected because installation would not produce a
  complete local memory system.
- Copy every provider into one Remem database: rejected because it creates a silo, weakens source
  ownership, and expands disclosure.

## Consequences

- The default experience is useful offline and requires no hosted memory service.
- Remem owns provisioning, migrations, health, backup guidance, and removal for the managed store.
- Provider contracts and provenance remain mandatory for the default store.
- Managed-store failure omits that provider and does not block the host or other providers.
- Import, synchronization, and writes to external systems require explicit policy and authorization.
