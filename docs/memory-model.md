# Memory Model

## Two Memory Planes

Remem separates recognition memory from recall memory.

Recognition memory is the compact catalog. It answers, "What might be known, and where?" Recall
memory remains in provider-owned records and answers, "What are the relevant details?"

The catalog is not evidence that a fact is true, and absence from the rendered catalog is not
evidence that no long-term memory exists. This separation implements
[ADR 0003](adr/0003-separate-recognition-from-recall.md).

## Provider and Topic Awareness

The current catalog renders two bounded levels:

1. provider descriptors explain which configured systems may contain decisions, preferences,
   documents, incidents, tasks, or history;
2. topic entries identify likely subjects and the provider IDs that can retrieve their details.

Entries can carry `parentId`, and the managed schema includes provider, topic, memory-topic, and
parent-catalog relationships. PostgreSQL CRUD currently creates one catalog entry per memory but
does not automatically classify records into an arbitrary-depth topic tree. Full branch population
and branch-selective rendering remain roadmap work. See
[ADR 0012](adr/0012-use-a-hierarchical-provider-topic-catalog.md).

## Catalog Entry

A catalog entry contains:

- stable ID within the catalog snapshot;
- title and optional aliases;
- short summary or retrieval hint;
- provider IDs likely to contain detail;
- scope;
- optional tags and importance; and
- optional source reference, parent identity, and embedding.

Catalog entries must be useful for recognition after aggressive truncation. Full note bodies never
belong in an entry.

## Memory Record

A normalized record contains:

| Field           | Meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `providerId`    | Adapter that supplied the record                                    |
| `id`            | Provider-specific stable identifier                                 |
| `title`         | Human-readable subject                                              |
| `content`       | Original provider content or excerpt                                |
| `summary`       | Optional compact summary                                            |
| `source`        | Path, URI, session reference, or provider locator                   |
| `scope`         | Visibility boundary                                                 |
| `type`          | Semantic, episodic, decision, preference, procedure, task, or other |
| `createdAt`     | Source creation time, when known                                    |
| `updatedAt`     | Source update time, when known                                      |
| `observedAt`    | Time the source observation occurred, when known                    |
| `confidence`    | Source/provider confidence, not retrieval relevance                 |
| `importance`    | Durable priority hint                                               |
| `freshness`     | Current, stale, superseded, or unknown                              |
| `provenance`    | Original source links and capture metadata                          |
| `entities`      | Optional structured entities                                        |
| `relationships` | Optional links to another memory or entity                          |
| `metadata`      | Provider-specific non-secret metadata                               |

`MemoryResult` wraps a record with query-dependent data such as retrieval score and match reasons.
Generated synthesis is never converted into an original provider record without an explicit write
and provenance link.

## Scopes

Initial scopes are:

| Scope       | Intended content                                                   |
| ----------- | ------------------------------------------------------------------ |
| `global`    | Durable user preferences and cross-project knowledge               |
| `workspace` | Knowledge attached to an OpenCode worktree                         |
| `project`   | Logical project knowledge when a workspace hosts multiple projects |
| `session`   | Temporary continuity and episodic state                            |

Retrieval orders equally relevant memories from narrowest to broadest scope, but broader scopes
remain searchable. Scope is an access and relevance boundary, not merely a ranking tag.

The Markdown adapter binds a `workspace` note to the current worktree only when its configured root
is inside that worktree. External workspace roots and Markdown notes using `project` or `session`
scope require `scope-id` in frontmatter and are excluded unless it matches the active context.
Global notes have no owner ID and are intentionally available across contexts that configure the
provider.

The PostgreSQL provider applies the same rule in SQL: global rows have no scope owner; workspace,
project, and session rows must match the active worktree, project ID, or session ID. The core
validates provider results again before ranking them.

Future scopes may include organization, team, repository, and branch. Adding one should not change
provider method signatures.

## Memory Types

- `semantic`: durable facts and concepts.
- `episodic`: what happened in a session or incident.
- `decision`: a choice, rationale, status, and supersession chain.
- `preference`: explicit user or project conventions.
- `procedure`: operational or development steps.
- `task`: unresolved or completed work state.
- `other`: provider data not safely classified.

Types do not imply truth or permanence. For example, an episodic observation can be current while a
decision can be superseded.

## Freshness and Conflict

Freshness is explicit. Newer timestamps can influence ranking but do not automatically invalidate
older records. Providers should identify supersession when they know it.

The synthesizer may present two inconsistent records and label their dates and sources. It must not
silently merge them into a fact. Automated reconciliation is a future, reviewable consolidation
operation.

## Provenance

Every injected item retains at least `providerId`, record `id`, and `source`. Unknown timestamps,
confidence, or scope remain unknown rather than receiving fabricated defaults.

Synthesis can summarize source material but must clearly separate:

- attributed source claims;
- ranking or freshness labels produced by Remem; and
- uncertainty or conflicts detected during processing.

Schema version 2 stores canonical sources separately from memory-provenance links. Explicit writes
without supplied provenance receive a user source such as `remem://explicit-write`; this is a
default locator, not proof that a person verified the content.

## Managed Mutations

`PostgresMemoryProvider` implements point reads, create, update, supersede, and delete. `MemoryManager`
selects a mutable provider, exposes the same operations with a provider-neutral API, and refreshes
provider catalog state after each mutation.

Supersession creates a replacement record and marks the old record `superseded` in one transaction.
Update rewrites the managed record while preserving its ID and creation time. Mutation APIs accept
actor/reason metadata and a context for resolving missing non-global scope IDs.

These are programmatic APIs, not model tools or an authorization layer. Callers must authorize the
operation and scope before invoking them. No OpenCode event automatically calls them.

## Managed Schema

The current database schema is version 3:

- version 1 creates providers, sources, memories, provenance, tags, aliases, topics, entities,
  relationships, catalog entries, full-text indexes, and 384-dimensional pgvector embeddings;
- version 2 adds session observations, candidate memories, and consolidation records.

Version 2 tables do not imply an active learning pipeline. They provide durable shapes for future
reviewable observation and consolidation. Migration mechanics are documented in
[Storage architecture](storage-architecture.md) and
[ADR 0016](adr/0016-use-ordered-transactional-checksum-migrations.md).

## Lifecycle

```text
provider record -> catalog recognition -> query result -> synthesized working memory -> expires
```

Working memory is dispatch-scoped in OpenCode v2 and is not automatically persisted. The codebase
defines observation, candidate, validation, and consolidation interfaces, but no host adapter writes
session activity into those tables. Durable memory changes happen only through explicit managed API
calls.

## Growth Control

Future consolidation should limit growth through deduplication, explicit supersession, topic
summaries, retention rules, and human-review queues. Importance decay can affect ranking, but must
not silently delete provider-owned source material. See [the roadmap](future-roadmap.md).
