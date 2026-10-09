# Managed candidate lineage

This implements the processed-association and atomic promotion portion of #49. It is a PostgreSQL guarantee; providers without `withCandidateTransaction` retain their existing consolidation behavior.

## Persistence and replay

Migration 0013 introduces a body-free ledger keyed by provider, scope kind, normalized scope key, and candidate UUID. It records state, resulting memory UUID, observation UUIDs, revision, action/actor codes, and version labels. An append-only audit records each revision in the same transaction. Retained legacy originating/latest associations are migrated only where they identify one memory. Missing intermediate history is not fabricated.

Automatic capture now persists its observation and candidate before promotion. The configured automatic policy can approve an ordinary screened candidate during that write. Without automatic policy the candidate stays pending. Re-extraction cannot alter approved, rejected, expired, promoted, or forgotten candidates. A changed pending extraction needs its expected ledger revision; identical replay is a no-op. Human review permits one pending transition and optionally checks an expected revision.

Managed consolidation plans against a transaction-bound provider. Memory, provenance, catalog, embeddings, candidate status, ledger, and audit commit together. Serializable transactions and bounded retries re-plan after concurrent edits rather than reusing stale mutation plans. Scope locks serialize candidate work within a provider/scope; the existing forget/restore lock also protects these writes. Connection-aware mutation helpers are shared with public write/update/supersede behavior; no nested transaction is assumed atomic.

Every duplicate merge keeps its own association. Replaying any processed candidate returns the existing record without writing its earlier content over manual edits or supersession. Deleted result memories and forgotten candidates leave body-free tombstones. A batch interruption after promotion commits cannot return that already-promoted candidate to pending work.

## Evidence availability and authority

`candidateLineage(id, context)` returns bounded, body-free audit information plus declared and currently available observation IDs. Scope rules apply to the ledger lookup. Missing evidence remains explicitly unavailable. Expiration does not reverify a claim. Forgetting candidate evidence does not automatically delete semantic memory that may have independent support; semantic removal remains a separately authorized operation.

Persisted reviewed candidate bodies are authoritative during promotion. Supplying `status: approved` cannot approve a stored pending candidate or replace its reviewed text. The existing direct approved-candidate core API remains trusted application code, not a host/model-facing approval endpoint. Stored legacy candidates without an attributable provider are refused by managed consolidation.

The ledger currently uses existing observation UUIDs. The first OpenCode capture slice emits separate normalized episodic events and legacy semantic observations; linking their canonical evidence IDs automatically remains follow-up work with #43/#96. Version labels distinguish this legacy/capture baseline; they do not assert a new verification policy. No root-cause or procedure verification is introduced here, and no correction-domain state machine is replaced.

## Verification

`tests/candidate-lineage.integration.test.ts` requires disposable PostgreSQL and exercises migration, all merged identities, restart, manual edits, supersession, deletion, concurrent deliveries, injected finalization failure, interruption after commit, review CAS, forged approval, expiry, forgotten replay, and independent support. Existing capture and real-host Session A/B gates remain required. A test database must be supplied through `REMEM_TEST_DATABASE_URL`; production memory is never a test fixture.
