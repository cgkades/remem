# ADR 0018: Explicit resumable concurrent index migrations

- Status: Accepted within the maintainer-authorized October 10 recovery scope (#87)
- Date: 2026-10-10

## Decision

Extend ADR 0016 only for immutable files explicitly marked `-- remem:concurrent-index`.
Each marked file contains one constrained CREATE INDEX CONCURRENTLY statement. Ordinary SQL
migrations keep their existing per-file transaction and checksum semantics. Host startup,
initialization and restore never grant nontransactional permission; an operator must run
`remem migrate --allow-nontransactional`.

Keep the same session advisory lock across DDL and ledger work. Before DDL, commit a body-free
progress receipt containing version, name, file checksum and owned index name. A retry verifies
both the complete applied prefix and this receipt. It refuses unrelated existing relations or
index definition drift. An owned invalid/not-ready index is dropped concurrently and rebuilt;
a matching valid/ready index is reused after a crash between build and ledger commit.
The final version insert and receipt deletion share one transaction. Never record success solely
because an index name exists or hide an interrupted build behind IF NOT EXISTS.

Only btree indexes over simple unquoted columns, optional ASC/DESC, optional UNIQUE, and optional
`WHERE column IS NOT NULL` are supported initially. More complex operations require a reviewed
extension rather than arbitrary nontransactional SQL. SQL files/checksums are unchanged; no new
production index is added without performance evidence. This is infrastructure for future
numbered migrations, not retroactive rewriting of migration 0008.

## Limits

Concurrent builds still take locks, use I/O/disk, wait for writers/snapshots and can fail. The
explicit DDL path defaults to a five-second lock wait and ten-minute statement limit; programmatic
callers may supply positive bounded millisecond values. Ordinary migration execution is unchanged.
Backend cancellation or termination leaves a diagnosable receipt and requires an explicit retry.
The advisory lock protects ReMem runners, not arbitrary external DDL by other administrators.

A generated stored column rewrite cannot be made nonblocking by concurrent index creation.
Existing-installation operations must schedule that rewrite separately. No automatic rollback,
index deployment on startup, capture-default change or new neural dependency follows from this ADR.

Migration runners acquire the session advisory lock using nonblocking probes with waits outside
an active SQL statement. Blocking advisory-lock SELECTs hold a virtual transaction that a
concurrent index build may itself wait for; polling avoids that deadlock. The advisory acquisition
limit defaults to ten minutes (or the API lock timeout override). Connection failure destroys the
checked-out client, ensuring session locks cannot leak into the pool.
