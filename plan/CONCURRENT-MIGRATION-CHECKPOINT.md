# Concurrent migration work checkpoint — October 10, 2026

- Branch: `feat/resumable-concurrent-index`, based on `da886e1728e9b0f52397d0b2ca2028de4beb0bad`.
- Scope: #87; #46 is already merged and is not duplicated.
- Implemented: explicit single-index file marker, opt-in CLI/API, persisted ownership/checksum receipt,
  invalid-index retry, built-index reuse, atomic ledger finalization, bounded DDL waits and doctor diagnostics.
- Existing numbered migration SQL/default transactions unchanged. No production index added.
- Tests drafted: real PostgreSQL opt-in/concurrency/interruption/checksum/ownership/lock/writer controls.
- Pending: GitHub PostgreSQL integration execution, full checks/native hosts, inspect any failures,
  update this checkpoint with verified head/run IDs before merge. Local container has no mapped
  unprivileged UID and cannot launch a safe PostgreSQL server; do not substitute mocks for DB acceptance.
- Next: publish a draft PR, run CI, fix verified defects, merge only after all #87 acceptance gates pass.

## Verified failure and fix

Run 38097440994 at c94c8c61972328a346224c1c6ce29aa680b3ce6d exposed a real
concurrent-runner deadlock: blocking pg_advisory_lock SELECT retained a virtual transaction
that CREATE INDEX CONCURRENTLY waited for. Replace it with pg_try_advisory_lock probes and
bounded waits outside active SQL statements. Trim executed DDL so the backend-termination
fixture identifies its active build. Checked-out connection errors now destroy the pooled client.
The other four PostgreSQL recovery/integrity tests passed. Pending rerun of all six plus full CI.
