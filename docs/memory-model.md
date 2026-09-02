# Memory Model

## Two Memory Planes

Remem separates recognition memory from recall memory.

Recognition memory is the compact catalog. It answers, "What might be known, and where?" Recall
memory remains in provider-owned records and answers, "What are the relevant details?"

The catalog is not evidence that a fact is true, and absence from the injected catalog is not
evidence that no long-term memory exists.

## Catalog Entry

A catalog entry contains:

- stable ID within the catalog snapshot;
- title and optional aliases;
- short summary or retrieval hint;
- provider IDs likely to contain detail;
- scope;
- optional tags and importance; and
- optional source reference.

Catalog entries must be useful for recognition after aggressive truncation. Full note bodies never
belong in an entry.

## Memory Record

A normalized record contains:

| Field | Meaning |
| --- | --- |
| `providerId` | Adapter that supplied the record |
| `id` | Provider-specific stable identifier |
| `title` | Human-readable subject |
| `content` | Original provider content or excerpt |
| `source` | Path, URI, session reference, or provider locator |
| `scope` | Visibility boundary |
| `type` | Semantic, episodic, decision, preference, procedure, task, or other |
| `createdAt` | Source creation time, when known |
| `updatedAt` | Source update time, when known |
| `confidence` | Source/provider confidence, not retrieval relevance |
| `importance` | Durable priority hint |
| `freshness` | Current, stale, superseded, or unknown |
| `metadata` | Provider-specific non-secret metadata |

`MemoryResult` wraps a record with query-dependent data such as retrieval score and match reasons.
Generated synthesis is never converted into an original provider record without an explicit write
and provenance link.

## Scopes

Initial scopes are:

| Scope | Intended content |
| --- | --- |
| `global` | Durable user preferences and cross-project knowledge |
| `workspace` | Knowledge attached to an OpenCode worktree |
| `project` | Logical project knowledge when a workspace hosts multiple projects |
| `session` | Temporary continuity and episodic state |

Retrieval orders equally relevant memories from narrowest to broadest scope, but broader scopes
remain searchable. Scope is an access and relevance boundary, not merely a ranking tag.

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

## Lifecycle

```text
provider record -> catalog recognition -> query result -> synthesized working memory -> expires
```

Working memory is turn-scoped and is not automatically persisted. Session observation may create a
candidate memory, but only policy-controlled consolidation may promote it to durable storage or the
catalog.

## Growth Control

Future consolidation should limit growth through deduplication, explicit supersession, topic
summaries, retention rules, and human-review queues. Importance decay can affect ranking, but must
not silently delete provider-owned source material.
