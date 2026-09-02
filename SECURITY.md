# Security Policy

## Reporting a Vulnerability

Report vulnerabilities through the repository's private GitHub security-advisory channel. Do not
open a public issue when a report could expose memory contents, credentials, private paths, or
provider access details.

Include affected versions, impact, reproduction steps, and any known mitigations. Maintainers will
acknowledge the report as soon as practical and coordinate disclosure after a fix is available.

## Supported Versions

Remem is pre-1.0. Security fixes are applied to the latest release and the default branch.

## Data Handling

Remem is local-first and has no telemetry. Managed mode runs the pinned
`pgvector/pgvector:0.8.1-pg16` image, publishes PostgreSQL on `127.0.0.1` only, and stores data in a
dedicated Docker volume. External mode connects to an operator-supplied PostgreSQL service and
inherits that operator's transport, authentication, retention, and monitoring policy.

The Markdown provider and default local hash embedding model make no remote requests. Remem does not
automatically persist OpenCode sessions, prompts, tool output, or model responses. Durable writes are
available only through explicit `PostgresMemoryProvider` or `MemoryManager` API calls.

## Secrets and Local Files

`remem init` generates a database password for managed mode. On POSIX platforms it creates its
configuration and data directories with mode `0700` and writes generated `config.json`, `.env`, and
Compose files with mode `0600`. `remem doctor` verifies the configuration and credential file modes.
The config file contains a database connection string and must be treated as a secret.

`REMEM_DATABASE_URL` can override the stored connection string. Prefer an environment or secret
manager over putting an external password on a shared command line. Do not place credentials in
Markdown frontmatter or OpenCode prompts.

Logical backups are custom-format `pg_dump` artifacts and contain memory content. Remem writes them
with mode `0600`, but does not currently encrypt, upload, rotate, or schedule them.

## Untrusted Memory

All retrieved catalog and record content is untrusted, even when it came from managed PostgreSQL. In
OpenCode v2, Remem adds a trusted system policy that defines this boundary and puts actual memory in
an ephemeral ordinary user message labeled as untrusted memory data. Stored requests to run tools,
reveal secrets, change policy, or write memory have no authority.

The OpenCode `1.18.26` adapter uses the older `chat.message` and `UserMessage.system` boundary. That
compatibility path is weaker because memory shares a privileged system field; use the v2 adapter
when possible.

## Destructive Operations

`remem restore FILE --confirm` runs
`pg_restore --clean --if-exists --schema=remem --single-transaction --exit-on-error` under a database
maintenance lock against the configured database.
`remem reset --confirm` removes the managed Docker volume and recreates an empty schema; it refuses
external mode. Neither command creates an automatic pre-operation backup.

## Failure Policy

Catalog, semantic recognition, provider, synthesis, hook, and logging failures fail open: OpenCode
continues without the affected memory augmentation. Authentication, scope filtering, migration
integrity, and explicit destructive-operation confirmation do not fail open. Database migration
drift disables successful setup rather than being repaired silently.

Mutation APIs are library APIs, not authorization systems. Callers must authenticate users, choose
the provider, validate scope, and authorize create/update/supersede/delete operations before calling
them. Remem does not expose mutation tools to the model.

See [`docs/security-model.md`](docs/security-model.md) for the threat model and operational
guidance, and [`docs/backup-restore.md`](docs/backup-restore.md) for recovery procedures.
