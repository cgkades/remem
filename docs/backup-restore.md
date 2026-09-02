# Backup and Restore

## What Is Implemented

Remem creates PostgreSQL logical backups in custom `pg_dump` format. The artifact contains the
canonical memories, provenance, catalog, vectors, migration ledger, and all other objects in the
`remem` schema. Other schemas in an external database are excluded. The dump does not contain the generated Remem config or `.env` as separate files, but
memory content inside the dump remains sensitive.

This implements the portable baseline from
[ADR 0017](adr/0017-use-logical-backup-and-recovery.md). Scheduled backups, retention, encryption,
remote upload, point-in-time recovery, and automatic pre-upgrade/pre-restore backups are not
implemented.

## Create a Backup

Use the default protected backup directory:

```sh
remem backup
```

The default filename is `remem-<ISO timestamp>.dump` under the platform data directory's `backups/`
folder. Choose a path explicitly with:

```sh
remem backup --output /secure/backups/remem-before-upgrade.dump
```

The output file is created exclusively and set to mode `0600` on POSIX systems. An existing file is
not overwritten.

Managed mode runs this command inside the PostgreSQL container:

```text
pg_dump --format=custom --no-owner --schema=remem
```

External mode runs the host `pg_dump` binary with connection values supplied through `PG*`
environment variables. Install compatible PostgreSQL client tools on the host before using external
backup.

## Protect and Validate Artifacts

- Store dumps outside the source checkout and outside the managed Docker volume.
- Encrypt artifacts with an operator-selected tool before remote storage.
- Restrict access as strongly as the live database.
- Keep more than one generation and test restore on a non-production database.
- Back up generated `config.json` and `.env` separately if the exact managed credentials and port are
  needed for disaster recovery.
- Record the Remem source/version and PostgreSQL major version used to create the dump.

Remem currently does not run `pg_restore --list`, compare counts, or execute representative retrieval
queries automatically. A successful command is not a complete recovery test.

## Restore

Restore is destructive within the Remem schema. It uses
`--clean --if-exists --no-owner --schema=remem` against the currently configured database and can
replace or remove Remem objects. Other schemas are excluded. Create and verify a separate backup first.

```sh
remem backup --output /secure/backups/pre-restore.dump
remem restore /secure/backups/selected.dump --confirm
remem doctor
```

The CLI refuses restore without `--confirm` and checks that the source is readable before invoking
`pg_restore`. Restore uses `--single-transaction --exit-on-error` under a database maintenance lock,
so an archive error rolls back rather than committing a partially replaced schema. After restore it
runs the normal migration verifier and applies any pending migrations.

Managed mode streams the local dump to `pg_restore` inside the container. External mode runs the host
`pg_restore` binary. Remem does not stop OpenCode or other database clients, create a fresh database,
or coordinate application downtime; the operator must prevent concurrent writes.

The success message confirms that `pg_restore` exited successfully and migrations completed. It does
not currently verify record counts, constraints beyond what PostgreSQL enforces, or representative
lexical/vector retrieval.

## Managed Reset

`reset` is not restore. It destroys the managed Compose volume, starts a new empty database, and
applies schema version 3:

```sh
remem reset --confirm
```

The command refuses external mode and refuses to run without `--confirm`. It does not create an
automatic backup. Use `remem backup` first if any data may be needed.

## External Recovery Ownership

For external mode, the database operator remains responsible for:

- server and storage snapshots;
- backup schedule and retention;
- encryption and key management;
- high availability and point-in-time recovery;
- PostgreSQL client/server version compatibility;
- TLS and network controls; and
- restore rehearsal and cutover.

Remem's logical dump is a portable application-level artifact, not a substitute for those controls.

## Configuration Overrides

`REMEM_DATA_DIR` changes the default backup directory. `REMEM_DATABASE_URL` changes the connection
used by external backup. Managed mode ignores that override and continues to use the configured
Docker container. See [Configuration](configuration.md).
