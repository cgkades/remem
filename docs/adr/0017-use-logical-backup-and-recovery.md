# ADR 0017: Use Logical Backup and Recovery

- Status: Accepted
- Date: 2026-09-01

## Context

The managed store contains durable user memory and must survive upgrades, corruption, and machine
migration. Filesystem copies of a live PostgreSQL data directory are unsafe and tightly coupled to
server binaries and platform layout.

## Decision

Use PostgreSQL logical backups and restores as the portable recovery baseline. Managed mode creates
a logical backup before risky schema or server upgrades and supports configurable scheduled backups,
retention, destination, and encryption policy. Restore into a fresh compatible PostgreSQL instance
with pgvector, then verify migration checksums, constraints, record counts, and representative
lexical and vector retrieval before cutover.

External mode leaves scheduling, retention, storage security, and server recovery to the operator,
but uses and documents the same logical restore verification path.

## Alternatives

- Copy the managed data directory: rejected because consistency and version compatibility are
  fragile.
- Require physical replication and point-in-time recovery initially: valuable later, but too
  operationally heavy as the portable baseline.
- Treat embeddings as the only backup: rejected because canonical content and provenance cannot be
  reconstructed from vectors.

## Consequences

- Backups are portable across supported platforms and PostgreSQL maintenance releases.
- Credentials and runtime secrets are excluded; backup files still contain sensitive memory and
  require access control and optional encryption.
- Recovery objectives depend on configured backup frequency; logical backup alone provides no
  point-in-time recovery.
- Backup failure is visible and blocks a guarded upgrade when required, but ordinary host operation
  continues with the last healthy provider state or without memory augmentation.
