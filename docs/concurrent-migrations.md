# Concurrent migration operations

Refs #87, ADRs 0016 and 0018. All existing numbered SQL migrations remain immutable and transactional.
The supported explicit extension applies only to a future file like:

```sql
-- remem:concurrent-index
CREATE INDEX CONCURRENTLY session_events_complete_order_idx ON remem.session_events (provider_id, project_id, session_id, occurred_at, id) WHERE evidence_id IS NOT NULL;
```

This example is not a shipped migration or index recommendation. #113 uses existing indexes.
New files must follow the next contiguous migration number. A marked file contains one supported
btree column-index operation; expressions, arbitrary SQL, IF NOT EXISTS, multiple statements and
other schemas are rejected before execution. A new file's full bytes determine its checksum.

Run `remem migrate --allow-nontransactional` deliberately when a release ships such a migration.
Plain `migrate`, host startup, init and restore refuse pending nontransactional steps. No global
config setting enables them. Default concurrent DDL limits are 5 seconds for lock waits and
10 minutes per statement; supported API options can increase these for a planned operation.
An aborted command is not evidence that the migration completed. `doctor` reports the pending
version and, after an interrupted build, the unfinished receipt. Rerun the same immutable file
with the explicit flag after resolving load/lock conditions. Retry rebuilds only an owned invalid
index or finalizes a matching valid one. A checksum/definition/ownership conflict requires operator
investigation; do not delete receipts, alter applied checksums or replace another relation to make
an installation appear healthy.

## Existing installations and migration 0008

Back up and rehearse against a disposable restore before maintenance. Inspect `doctor` and the
applied prefix. Migration 0008 adds a stored generated search vector to `session_events`, which
can rewrite the table under an exclusive lock. Its ordinary indexes also lock writers. This new
mechanism does not change that already-shipped file, make the rewrite concurrent, or repair a
partially hand-applied version. Installations awaiting 0008 still need a maintenance window sized
from their actual table and workload; stop host writes, apply the ordinary migrations, validate and
resume. Installations already past 0008 retain their original checksums and need no retroactive DDL.

For future large-table changes, separate an unavoidable rewrite into an ordinary transaction and
any justified indexes into their own marked numbered steps. Rehearse lock waits, space and I/O
costs on a representative restore. `CREATE INDEX CONCURRENTLY` allows ordinary writes but still
waits for active writers and old snapshots; the ReMem advisory lock serializes migration runners,
not application transactions or independent administrator DDL. Never point the test harness at
installed memory: its fixtures drop the `remem` schema.

Integration tests exercise operator opt-in, concurrent runners, index/ledger interruption,
backend termination, retry, checksum and definition drift, SQL constraints, lock timeout and
ordinary-write availability. These gates establish recovery/locking behavior, not production
migration duration or a zero-downtime promise.
