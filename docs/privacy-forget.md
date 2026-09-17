# Explicit Privacy Forgetting

`remem forget` is review-gated. It never infers a deletion target from model
output and it never removes data until a person confirms a recent preview.

## Workflow

Preview one scoped evidence record:

```sh
remem forget <EVIDENCE_ID> --project <PROJECT_ID>
```

The command emits a body-free JSON preview containing an opaque preview ID,
the provider/project/evidence identifiers, direct-candidate count, and its
15-minute expiry. It does not print or store episode, candidate, memory, or
embedding content in the preview or its audit rows.

Confirm the exact preview before it expires:

```sh
remem forget <PREVIEW_ID> --confirm
```

The installed CLI requires an interactive terminal and asks the person at that
terminal to retype the preview ID before it performs confirmation. This is a
human-presence safeguard, not an identity/authorization system: access to the
local operating-system account and database remains the authorization boundary.
Do not expose this command to untrusted shell users or agents. A future
authenticated multi-user deployment must bind previews to an authorized
principal before enabling this workflow outside that local boundary.

Confirmation atomically removes the canonical episode record and only the
candidate rows directly linked to it. It writes body-free tombstones for those
identifiers. Replayed host events with the same evidence ID return a
`forgotten` append outcome instead of recreating the episode.

## Deliberate Scope

TASK-013 does **not** delete semantic memories, their embeddings, catalog
entries, sources, or relationship/entity rows. A semantic memory may have
independent supporting evidence, and the current schema has no durable ledger
that can prove it was derived solely from the forgotten episode. The preview
makes that distinction explicit with `semanticMemoryCount: 0`; Phase 4's
association ledger is the prerequisite for any separately reviewed semantic
forgetting policy.

Ordinary episode expiry or hard-limit capacity eviction is not privacy
forgetting: it can remove an episode under retention policy but does not create
a tombstone or authorize deletion of related candidate/semantic data.

## Backups And Restore

Existing backups can retain content that was present when they were created.
They must be stored and expired according to the operator's backup-retention
policy; `remem forget` cannot erase an offline backup copy.

When `remem restore <FILE> --confirm` restores into the same database, it
snapshots the current database's body-free forget tombstones before
`pg_restore --clean`, then reapplies them after migration. This suppresses the
forgotten episodes and direct candidates in the restored backup, including a
backup that predates the forget request. Moving a backup to a different or new
database does not carry this local suppression state unless its tombstones are
also restored; operators must not treat that as a privacy-complete restore.
