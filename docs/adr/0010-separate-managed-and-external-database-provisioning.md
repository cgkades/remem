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
- Failed validation leaves the provider disabled and the host usable; it never weakens security or
  mutates an unverified server to make startup succeed.
