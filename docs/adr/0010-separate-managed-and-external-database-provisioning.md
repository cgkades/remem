# ADR 0010: Separate Managed and External Database Provisioning

- Status: Accepted
- Date: 2026-09-01

## Context

Most local users need a zero-administration default, while teams may require an existing PostgreSQL
service, TLS policy, centralized backups, or infrastructure controls. Treating these as one lifecycle
mode risks modifying an unrelated database or pretending an external service is locally managed.

## Decision

Support two explicit modes using the same PostgreSQL provider schema and runtime adapter:

- managed mode provisions a dedicated local cluster, database, role, generated credential, data
  directory, loopback-only listener, migrations, and health checks; and
- external mode accepts an operator-supplied connection, validates PostgreSQL and pgvector versions,
  TLS policy, privileges, and migration state, but never starts, stops, upgrades, or backs up the
  server.

Implementation status: both modes use the same provider and schema. Managed Docker lifecycle and
loopback binding are implemented. External `doctor` currently checks connectivity, pgvector,
migration state, and a database write; explicit supported-version, TLS-policy, and privilege-range
validation remains deferred. External backup/restore is an explicit CLI request, never an automatic
server lifecycle action.

## Alternatives

- Auto-detect and reuse any local PostgreSQL: rejected because ownership and safe mutation are
  ambiguous.
- Support only an external database: rejected because it defeats the managed local-first default.
- Support only the bundled lifecycle: rejected because it blocks established operators.

## Consequences

- Mode and ownership are visible in configuration and diagnostics.
- Secrets need restrictive storage and redaction in both modes.
- Provisioning is idempotent and never exposes the managed database beyond loopback by default.
- External operators own availability, TLS, backup scheduling, retention, and server upgrades.
- Failed CLI validation returns an error. At prompt time, an unavailable provider is isolated and the
  host remains usable; fail-open behavior never weakens scope or migration checks.
