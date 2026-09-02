# Architecture

## Purpose

Remem is a local-first memory control plane between agent hosts and heterogeneous long-term memory
systems. It keeps a compact recognition catalog visible, decides when recall is warranted, routes
bounded queries to providers, and injects attributed results without making memory availability a
prerequisite for using the host.

The target architecture includes a managed local PostgreSQL and pgvector store as the default
provider. This improves installation, semantic recognition, and durable learning without turning
the orchestration core into a database-specific application. Existing Markdown, session, MCP, and
remote stores remain independent providers and systems of record unless the user explicitly imports
their data.

The core sequence is:

```text
recognition -> retrieval planning -> recall -> synthesis -> context injection
```

It is deliberately not `prompt -> vector search -> nearest-neighbor dump`.

## Architecture Status

The implemented MVP establishes the host-independent orchestration core, provider contracts,
Markdown provider, deterministic and lexical recognition, bounded extractive synthesis, and the
isolated OpenCode v1 adapter. The managed PostgreSQL provider, semantic recognition, hierarchical
catalog persistence, learning pipeline, and OpenCode v2 adapter are accepted direction and are not
all implemented yet.

OpenCode v2 is the current official API but is still beta as of 2026-09-01. Remem therefore treats
its API as a versioned adapter boundary rather than as a stable core dependency.

## Design Principles

- Local-first means the default durable store runs on the user's machine and binds only to loopback.
- Managed means Remem provisions and maintains its default provider, not that Remem owns every
  memory source.
- Orchestration policy remains independent of storage SDKs, host message types, and model vendors.
- Recognition is cheaper and smaller than recall; retrieved detail appears only when warranted.
- Memory enhancement fails open, while authorization, scope, and integrity checks fail closed.
- Retrieved memory is attributed, bounded, and treated as untrusted data rather than instructions.

## Runtime Recall

The OpenCode v2 adapter uses the official beta `ctx.session.hook('context')` API. The hook runs
immediately before each model dispatch, including every tool-loop model call, so Remem computes
fresh, ephemeral context without persisting augmentation into the conversation. Other hosts can
provide the same normalized pre-dispatch contract through their own adapters.

```mermaid
sequenceDiagram
    participant U as User
    participant H as Agent Host
    participant A as Host Adapter
    participant O as Orchestration Core
    participant C as Hierarchical Catalog
    participant R as Provider Router
    participant P as Managed PostgreSQL Provider
    participant E as External Providers
    participant M as Model

    U->>H: Submit prompt
    loop Every model dispatch, including tool-loop calls
        H->>A: Ephemeral pre-dispatch context hook
        A->>O: Normalized prompt and session context
        O->>C: Stage 0 and Stage 1 recognition
        C-->>O: Ranked provider and topic candidates
        alt Recall warranted
            O->>R: Bounded retrieval plan
            par Local default
                R->>P: Scoped lexical or semantic recall
                P-->>R: Attributed records
            and Other systems of record
                R->>E: Capability-bounded recall
                E-->>R: Attributed records or isolated failures
            end
            R-->>O: Settled results
            O->>O: Rank, deduplicate, synthesize, and budget
        end
        O-->>A: Catalog plus optional untrusted recalled data
        A-->>H: Ephemeral context augmentation
        H->>M: Dispatch assembled context
    end
```

The isolated v1 compatibility adapter retains the implemented `chat.message` approach, which writes
turn-level context to `UserMessage.system`. It does not emulate v2 lifecycle semantics in the core
and can be removed independently when v1 support ends.

## Recognition and Planning

The catalog is a bounded hierarchy of provider roots, topics, and subtopics. Nodes contain aliases,
scope, retrieval hints, provider locations, and compact summaries, not detailed memory bodies. A
topic can point to more than one provider location, preserving cross-provider recall without
pretending the underlying records share ownership or consistency.

Planning has three bounded stages:

1. Stage 0 applies explicit continuity, identifiers, exact aliases, and other deterministic signals.
2. Stage 1 combines lexical scoring with local semantic similarity over catalog entries. Embeddings
   recognize likely topics; they do not establish truth or bypass provider scope filters.
3. Stage 2 optionally uses a configured model planner only when earlier stages are ambiguous.

The implemented MVP calls its lexical-only pass Stage 1. The target keeps that lexical evidence and
adds pgvector-backed semantic recognition at the same stage, with deterministic fallback when
embedding generation or vector search is unavailable.

## Provider Orchestration

Every backend implements the capability-driven `MemoryProvider` contract and returns normalized
catalog entries, records, provenance, and retrieval signals. Providers do not decide whether a
prompt deserves recall, how cross-provider results rank, or what enters model context.

The router executes only planned requests. Each request has its own timeout, scope, output budget,
and failure boundary. Provider similarity is retrieval evidence, not factual confidence. The
managed default provider and every external adapter are peers at this boundary.

```mermaid
flowchart LR
    HA[Host Adapters] --> Core[Host-Independent Orchestration Core]
    Core --> Contracts[Provider Contracts]
    Contracts --> PG[Managed PostgreSQL Adapter]
    Contracts --> MD[Markdown Adapter]
    Contracts --> SP[Session Provider]
    Contracts --> RP[Remote and MCP Providers]
```

The contracts import no OpenCode, PostgreSQL client, filesystem, network, or model SDK types.

## Managed Storage

The default provider uses PostgreSQL for transactional records, scopes, provenance, provider
metadata, and catalog relationships; PostgreSQL full-text facilities support lexical retrieval and
pgvector stores embeddings for semantic recognition and recall. The database is a provider-owned
system of record for Remem-native memories. External provider bodies are not copied into it unless
an explicit import or learning policy authorizes that write.

```mermaid
flowchart TB
    subgraph Remem[Remem Process]
        Core[Orchestration Core]
        Router[Provider Router]
        Adapter[PostgreSQL Provider Adapter]
        Lifecycle[Managed Database Lifecycle]
    end

    subgraph DB[Dedicated Local PostgreSQL and pgvector]
        Records[Memory Records and Provenance]
        Catalog[Provider and Topic Hierarchy]
        Search[Full-Text Indexes and Vector Embeddings]
        Ledger[Ordered Migration Ledger and Checksums]
    end

    Core --> Router --> Adapter
    Adapter --> Records
    Adapter --> Catalog
    Adapter --> Search
    Lifecycle --> Ledger
    Lifecycle -. provision, start, health .-> DB
    Backup[Logical Backup] -. pg_dump and pg_restore .-> DB
    Router --> External[Independent External Providers]
```

Managed mode provisions a dedicated local cluster, database, role, data directory, and generated
credential with restrictive filesystem permissions. It listens on loopback only and does not reuse,
reconfigure, or expose an unrelated PostgreSQL installation. Exact packaging can vary by platform
without changing the provider contract.

External mode accepts an operator-supplied PostgreSQL connection and manages no server process. It
validates connectivity, supported PostgreSQL and pgvector versions, schema privileges, and migration
state before enabling the provider. TLS and credential handling follow the external operator's
policy. Both modes use the same schema and adapter after connection establishment.

## Installation

Installation makes the provisioning choice explicit. Managed local storage is the default; external
database configuration is an opt-in for users who already operate PostgreSQL.

```mermaid
flowchart TD
    A[Install Remem] --> B{Database mode}
    B -->|Managed default| C[Preflight platform and storage]
    C --> D[Provision dedicated local PostgreSQL]
    D --> E[Create restricted role, database, and pgvector]
    B -->|External| F[Read operator-supplied connection securely]
    F --> G[Validate TLS policy, version, pgvector, and privileges]
    E --> H[Acquire migration lock]
    G --> H
    H --> I[Verify ordered checksums and apply transactional migrations]
    I --> J[Health and recovery-readiness checks]
    J --> K[Configure selected host adapter]
    K --> L[Ready]
    C -->|Failure| X[Report storage unavailable without altering unrelated services]
    G -->|Failure| X
    I -->|Failure or drift| X
```

Provisioning is idempotent and must not mark an installation ready after a partial schema change.
Credentials are never written to logs or model context. At runtime, an unavailable database disables
that provider and memory augmentation fails open; installation and migration integrity checks do not
silently bypass an unsafe configuration.

## Recall and Synthesis

Recall combines provider results, removes content-equivalent duplicates, preserves every source
reference, and ranks with bounded contributions from relevance, scope, importance, freshness, and
provider confidence.

Synthesis is selected behind one contract:

- deterministic extractive synthesis is the default and fallback;
- a local model strategy may summarize within explicit resource and token budgets; and
- an external model strategy requires explicit disclosure, privacy, and cost configuration.

Every strategy preserves adjacent provenance, marks stale or conflicting evidence, obeys a hard
context budget, and can return no augmentation. A synthesis must not silently reconcile conflicts or
become a durable memory merely because a model generated it.

## Untrusted Memory Boundary

Provider content, catalog summaries, embeddings, tool results, and generated syntheses are untrusted
data. Remem places them in a clearly delimited, attributed section that instructs the model to use
them only as possible evidence. Embedded requests to run tools, reveal secrets, change policy,
override the user, or write memory have no authority.

Scope and authorization are enforced before retrieval, not delegated to the model. Logs omit raw
memory by default, diagnostics are sanitized, SQL is parameterized, and provider output is bounded
before normalization. Suspicious content may be labeled or omitted, but filtering is not treated as
a complete prompt-injection defense.

## Future Learning

Learning remains separate from recall. Host observations become candidates through a normalized
event interface; they are not durable facts until policy and, where configured, user review approve
them. Generated synthesis and retrieved instructions never promote themselves.

```mermaid
flowchart TD
    A[Normalized Session Activity] --> B[Candidate Extraction]
    B --> C[Redaction, Scope, and Trust Classification]
    C --> D[Deduplication and Conflict Detection]
    D --> E{Learning Policy}
    E -->|Reject or expire| F[Discard Candidate]
    E -->|Require review| G[User Review]
    G -->|Reject| F
    G -->|Approve| H[Transactional Provider Write]
    E -->|Explicitly authorized automatic path| H
    H --> I[Update Topic Hierarchy]
    H --> J[Generate or Refresh Embedding]
    I --> K[New Catalog Snapshot]
    J --> K
    K --> L[Available to Future Recognition]
```

Writes to the managed provider update records, catalog relationships, and index state transactionally
or through an idempotent work queue. External writes use advertised provider capabilities and retain
their provider's consistency semantics. Learning failures never interrupt the active host request.

## State and Concurrency

Durable state belongs to providers. The managed provider stores Remem-native memory and catalog
state; external providers retain their own records. The orchestration process keeps bounded,
context-keyed catalog snapshots, provider capabilities, and sanitized session diagnostics.

Catalog publication is atomic. Provider reads can run concurrently, every result remains associated
with the session and dispatch that requested it, and no global mutable current prompt is used.
Managed writes and migrations use database transactions; lifecycle operations use exclusive locks.

## Migration and Recovery

Schema migrations are immutable, ordered files recorded with checksums in a migration ledger. One
process acquires a database lock, verifies the complete applied prefix, and applies each pending
migration transactionally. A gap, changed checksum, unsupported version, or failed migration
disables the provider and requires operator action; Remem never guesses at schema repair or runs an
automatic destructive downgrade.

Managed mode creates logical backups before risky upgrades and supports configurable scheduled
logical backups. Recovery restores into a fresh compatible PostgreSQL instance with pgvector, then
verifies migration checksums, constraints, record counts, and representative retrieval. Credentials
and runtime secrets are not part of backups. External-mode backup scheduling and retention remain
the database operator's responsibility, while Remem documents and verifies the logical restore path.

## Failure Boundaries

Every augmentation path fails open:

- host-hook or adapter mismatch: dispatch without Remem context;
- catalog failure: skip automatic recognition or use an already valid bounded snapshot;
- semantic recognition failure: fall back to deterministic and lexical signals;
- one provider failure: use settled results from other providers;
- all providers fail: inject no recalled memory;
- synthesis failure: fall back to bounded extractive synthesis, catalog only, or no augmentation;
- learning or backup failure: report sanitized diagnostics without interrupting the active request;
- logging failure: do not affect context assembly.

Fail-open behavior never means bypassing authentication, scope, migration integrity, or trust
boundaries. When those checks fail, the affected provider is disabled rather than accessed
insecurely. Errors appear in diagnostics but are not inserted into model context as remembered facts.

## Observability

Each dispatch produces a structured trace containing recognition and planning decisions, provider
timing and counts, isolated failures, deduplication, synthesis strategy, and estimated token use.
Normal logs contain no raw memory, embeddings, credentials, or connection strings. Host tools expose
bounded health and the latest sanitized trace when deeper diagnosis is requested.

## Model and Host Portability

Injected memory uses ordinary host context and provider-neutral text. The core does not use
Anthropic-specific blocks, OpenAI-only roles, Bedrock-incompatible fields, or OpenCode message types.
Host and model optimizations remain optional adapters, so PostgreSQL and OpenCode v2 are defaults at
their respective boundaries rather than definitions of the architecture.
