# Explicit semantic memory forgetting

Select one project-scoped memory by its identifier. This is a separate operator
workflow from episode forgetting; the existing evidence confirmation still
preserves independently reviewed semantic memories.

```sh
remem forget <MEMORY_ID> --semantic --project <PROJECT_ID>
remem forget <SEMANTIC_PREVIEW_ID> --semantic --confirm
```

The first command is non-destructive. Its body-free preview discloses one
semantic target, linked candidate copies, source records, private canonical
evidence, embeddings (including staged reindex vectors) and catalog projection
counts. Shared sources/evidence supported by other retained records are
counted as retained. The second command requires a terminal and retyping that
exact preview identifier, as the existing privacy workflow does. Do not expose
this operator CLI to untrusted agents or shell users. Native memory tools
receive no deletion capability from this feature.

Confirmation deletes only the disclosed selected memory and associated private
copies. Foreign providers/projects, other memories, independently shared source
records and supporting evidence remain. Aliases, tags, provenance, relationship
edges and memory/entity links cascade with the selected memory. Entity identities
remain separate durable records. Shared original evidence can still be recalled
as historical data; its retention is visible in the preview. This is not an
automatic inferred cascade to every record with similar wording.

A preview expires after fifteen minutes. A digest binds its current body,
candidate/lineage/provenance/source associations, private versus shared evidence
and projection state. Changed sharing, sources, aliases, bodies or supersession
require a new preview. Bounds are 100 candidate/source/provenance records, 1000
projection rows and 1600 observation links; larger targets fail closed. Old
preview rows are removed by later preview operations. SQL statements have a
two-second limit and abort is checked before commit. Failures/cancellation roll
back deletions and tombstones. Evidence appends and managed memory mutations
share the existing forget/restore lock; lock acquisition is bounded and a failed
session lock release destroys the connection. Capture modes/defaults are unchanged.

Body-free tombstones and lineage survive removal. Existing deterministic replay,
candidate promotion and database triggers cannot revive the selected row or
its forgotten candidate identities, including older writers that bypass current
provider helpers. These decisions are retained and reapplied when restoring an
older backup into this same database through `remem restore`. Orphan sources
are removed; independently shared sources remain. Restore records a body-free
privacy suppression action. An independently authorized new source may support
a new memory; forgetting is not a permanent ban on a phrase.

This workflow currently selects project-scoped semantic targets. Other scope
types, offline backup files, cross-database restores, external exports and
already-dispatched model context are outside this deletion boundary. Access to
the local OS account/database remains the authorization boundary; a multi-user
deployment would require principal-bound previews. No production database or
backup is modified by the automated acceptance tests.

Acceptance uses nine real PostgreSQL cases for private/shared copies, scope,
changed/expired/bounded previews, supersession, concurrent promotion/confirmation,
failure/cancellation, replay rejection, fresh-session recall and actual
`pg_dump`/`pg_restore`, plus both CLI mode confirmation controls. Verification
status and actual results are recorded in the development checkpoint.
