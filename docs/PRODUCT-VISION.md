# ReMem Product Vision

> **Status:** Normative target-state document.
>
> When implementation, roadmap, issues, or older documentation conflict with this document, this document describes the product we intend to build. Architectural constraints in accepted ADRs still apply unless explicitly superseded.

## One-sentence definition

**ReMem is a local-first memory system that allows an AI coding agent to naturally develop useful memory of its work, recognize when that memory matters later, and recover the right context without requiring the user to manage memory manually.**

ReMem is not primarily a vector database, transcript search tool, or explicit `remember` command. Those can be components or escape hatches. The product is the behavior produced by the complete memory lifecycle.

## The problem

Coding agents lose useful knowledge across sessions, compaction, host restarts, and model changes. External memory stores can retain information, but storage alone does not solve the problem. The agent must also know:

- what kinds of things it can remember;
- what it has learned about the current project, user, entities, systems, and procedures;
- when a new prompt probably relates to prior work;
- where relevant evidence is stored;
- how to retrieve it without flooding context;
- which information is current, stale, conflicting, or merely historical;
- what happened during the current session that is worth preserving;
- how new experience changes what should be remembered in the future.

The user should not have to repeatedly say "search memory," "remember this," or curate a database to obtain normal continuity.

## Product contract

A correctly functioning ReMem installation should satisfy this contract:

1. **Observe naturally.** Significant work can become memory even when the user did not phrase it as a memory-management command.
2. **Preserve evidence.** ReMem retains enough episodic provenance to answer what actually happened and why a durable conclusion exists.
3. **Consolidate knowledge.** ReMem can turn repeated or completed experience into compact semantic memory representing what is currently known.
4. **Recognize relevance before recall.** A compact memory map/catalog helps determine whether prior knowledge is likely to matter.
5. **Retrieve selectively.** ReMem routes bounded queries only to relevant providers/scopes and avoids indiscriminate nearest-neighbor dumps.
6. **Synthesize for use.** Retrieved evidence is converted into compact, attributed working context that preserves uncertainty and conflict.
7. **Inject automatically.** Relevant working memory reaches the agent before model dispatch without requiring an explicit search command.
8. **Improve over time.** Newly learned durable information updates recognition/catalog state so later recall becomes easier.
9. **Remain local by default.** Session content and durable memory do not leave the machine unless the user explicitly configures a remote provider or model path that requires it.
10. **Never make memory a host dependency.** Memory augmentation fails open. Scope, authorization, integrity, and trust checks fail closed.

## The two kinds of durable memory

ReMem needs both semantic and episodic memory. Neither replaces the other.

### Semantic memory: what is currently known

Examples:

- "Phoenix production PostgreSQL is version 17."
- "This repository uses pnpm, not npm."
- "The user prefers feature branches and PRs."
- "The Bedrock authentication failure is fixed by forwarding the credential provider chain."

Semantic memory should be compact, current, deduplicated, conflict-aware, and optimized for future recognition and use.

### Episodic memory: what actually happened

Examples:

- the migration investigation that discovered an incompatible extension;
- the sequence of tests that established the root cause;
- the prior failed approach and the evidence showing why it failed;
- when a decision was made and which session/source produced it.

Episodic memory should preserve evidence and provenance. It is not rewritten merely because the current semantic conclusion changes.

**Invariant:** semantic memory is optimized for remembering what is currently known; episodic memory is optimized for remembering what actually happened.

## The complete memory lifecycle

The intended system is a closed loop, not just a retrieval pipeline.

```text
SESSION EXPERIENCE
    |
    v
observation
    |
    v
significance / trust / scope classification
    |
    +-----------------------> bounded episodic memory
    |
    v
candidate extraction
    |
    v
deduplication + conflict/staleness detection
    |
    v
learning policy
    |                 \
    |                  \ ambiguous/high-risk
    |                   -> human review
    v
automatic safe consolidation
    |
    v
semantic memory + relationships + catalog/index update
    |
    v
RECOGNITION
    |
    v
retrieval planning -> provider recall -> ranking -> synthesis
    |
    v
bounded attributed context injection
    |
    v
NEXT AGENT EXPERIENCE
```

The existing recall sequence remains a core invariant:

```text
recognition -> retrieval planning -> recall -> synthesis -> context injection
```

It must **not** collapse into:

```text
prompt -> vector search -> nearest-neighbor dump
```

## Automatic does not mean indiscriminate

The goal is automatic memory management with conservative policy, not recording everything.

ReMem should preferentially learn:

- explicit user corrections and durable preferences;
- architectural and implementation decisions;
- durable project facts;
- root causes established by evidence;
- verified successful procedures;
- important project-state transitions;
- unresolved blockers/tasks that need continuity;
- entities and relationships useful for future recognition;
- superseding information that changes an older conclusion.

ReMem should normally avoid promoting:

- casual conversation;
- transient command output;
- unverified model claims;
- failed hypotheses as current truth;
- secrets and credentials;
- quoted/retrieved content merely because it appeared in context;
- every intermediate tool call;
- generated synthesis with no supporting provenance.

Raw or normalized episodic evidence may have a different retention policy from semantic promotion.

## Learning policy

Human review is an important safety mechanism, but it must not become the normal path for ordinary low-risk memory formation.

The target policy has three outcomes:

1. **Auto-promote:** high-confidence, low-risk, well-scoped memories with sufficient evidence.
2. **Review:** ambiguous, conflicting, high-impact, low-confidence, or policy-sensitive candidates.
3. **Reject/expire:** low-value, unsafe, redundant, or transient candidates.

An explicit "remember this" request is a strong learning signal, not the only way learning occurs.

## Recognition catalog / memory map

The catalog is a compact always-available recognition structure, not a dump of all memory. It should represent enough of the memory landscape to answer questions such as:

- Have we worked on Phoenix before?
- Is there remembered information about Bedrock authentication?
- Which provider contains the relevant project history?
- Is there a known procedure for this failure?
- Which entities/topics are related to this prompt?

It should evolve when durable memory evolves. Topics, entities, aliases, relationships, scopes, and retrieval hints should be derived/maintained automatically where safe.

Absence from injected context must never be interpreted as absence from durable memory.

## Provider model

ReMem is the orchestration layer. Providers are systems of record or evidence sources.

The managed PostgreSQL/pgvector provider is the default ReMem-native store, not the definition of ReMem. Markdown, Obsidian, session history, Mem0, Cognee, MCP, and future providers can participate through capability-based adapters.

Providers do not decide:

- whether a prompt warrants recall;
- global ranking across providers;
- what is trusted;
- what enters final model context;
- whether retrieved content can promote itself into durable memory.

## Local-first privacy invariant

Default ReMem operation must not upload memory, transcripts, prompts, embeddings, or session observations to a remote service.

Network access may be needed for installation, package/model download, or explicitly configured remote providers/models. These are separate from memory transport and must not silently cause memory content to leave the machine.

Future sync/export is explicit opt-in.

## Host and model independence

ReMem's memory lifecycle belongs in the host-independent core. OpenCode, Pi, and future hosts adapt their event/dispatch semantics to normalized contracts.

The architecture must not require one model vendor to function. Optional model-backed classification, planning, or synthesis must have clear local/default behavior and failure boundaries.

## Required behavioral acceptance scenario

This scenario is the product-level definition of "ReMem works."

### Session A

In a clean project/session, the user and agent:

1. investigate a nontrivial failure;
2. try at least one plausible approach that is shown to be wrong;
3. discover a root cause using tool/test evidence;
4. choose an implementation decision;
5. apply and verify a successful fix;
6. leave one relevant follow-up task unresolved;
7. end the session without manually curating memory.

### Session B

Start a fresh host session with no conversation history and use a natural continuity prompt such as:

> "Let's continue the Phoenix database work."

Without saying `remember`, `memory`, `recall`, or `search`, ReMem should provide the agent with bounded context containing, when relevant:

- the current verified root cause/conclusion;
- the successful procedure or fix;
- the implementation decision;
- the unresolved follow-up;
- provenance sufficient to inspect what happened;
- not the disproven hypothesis as current truth.

An unrelated prompt should not inject detailed Phoenix memory.

This acceptance scenario should eventually be automated as an end-to-end regression test.

## Product anti-goals

ReMem is not intended to become:

- a giant prompt prefix containing everything ever remembered;
- a vector database wrapper;
- a transcript-only search engine;
- a mandatory manual knowledge-management workflow;
- an OpenCode-specific application with memory logic embedded in host adapters;
- a system where every specialized memory type implements its own unrelated lifecycle/review infrastructure;
- an autonomous truth engine that silently resolves meaningful contradictions;
- a cloud memory service by default.

## Priority rule

When choosing between work that improves the complete memory lifecycle and work that expands integrations, packaging, specialized workflows, or UI, complete memory behavior wins until the behavioral acceptance scenario above is reliable.

The project should be judged primarily by this question:

> **Does the agent naturally develop useful memory of its work and know when to use it later?**
