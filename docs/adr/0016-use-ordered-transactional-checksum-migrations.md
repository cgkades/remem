# ADR 0016: Use Ordered Transactional Checksum Migrations

- Status: Accepted
- Date: 2026-09-01

## Context

Managed and external databases need identical, auditable schema evolution. Automatic schema sync or
mutable migration files can hide drift and leave records, topic relationships, and vector indexes at
incompatible versions.

## Decision

Ship immutable, monotonically ordered migrations. Under a PostgreSQL advisory lock, verify that the
migration ledger is a complete prefix with matching checksums, then apply each pending migration in
its own transaction and record its checksum atomically. Refuse gaps, edits, unknown applied versions,
and unsupported extension state. Use explicit recovery migrations rather than automatic down
migrations.

## Alternatives

- ORM schema synchronization: rejected because implicit destructive changes and drift are difficult
  to audit.
- Mutable idempotent startup SQL: rejected because the installed schema cannot be proven.
- One transaction for every release migration: rejected because it creates an unnecessarily large
  lock and recovery unit.

## Consequences

- Concurrent startup cannot race schema changes, and installed history is verifiable.
- Published migration files can never be rewritten; fixes require a new migration.
- Operations that PostgreSQL cannot transact need an explicit resumable migration design and review.
- A mismatch or failure disables the database provider, emits sanitized recovery guidance, and
  leaves the agent host usable without memory augmentation.
