# ADR 0017: Use Logical Backup and Recovery

- Status: Accepted
- Date: 2026-09-01

## Context

The managed store contains durable user memory and must survive upgrades, corruption, and machine
migration. Filesystem copies of a live PostgreSQL data directory are unsafe and tightly coupled to
server binaries and platform layout.

## Decision

Use PostgreSQL logical backups and restores as the portable recovery baseline. The target managed
policy creates a logical backup before risky schema or server upgrades and supports configurable
scheduled backups, retention, destination, and encryption policy. The target recovery procedure
restores into a fresh compatible PostgreSQL instance with pgvector, then verifies migration
checksums, constraints, record counts, and representative lexical and vector retrieval before
cutover.

External mode leaves scheduling, retention, storage security, and server recovery to the operator,
but uses and documents the same logical restore verification path.

Implementation status: `remem backup` creates an on-demand custom-format `pg_dump` artifact, and
`remem restore FILE --confirm` transactionally cleans/restores the `remem` schema in the currently
configured database under a maintenance lock before running the
migration verifier. Automatic pre-operation backups, scheduling, retention, encryption, fresh-target
creation, record-count checks, and representative retrieval verification remain deferred.

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
- Recovery objectives depend on operator backup frequency until scheduling exists; logical backup
  alone provides no point-in-time recovery.
- Backup failure is visible. A future guarded upgrade can require a successful backup, while ordinary
  host operation continues with the last healthy provider state or without memory augmentation.
