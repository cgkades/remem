# Correction Candidate Review Workflow

An expert correction never writes to memory directly. It is diagnosed,
turned into the smallest possible mutation, structurally validated, replayed
against a live orchestrator, and only applied after an explicit human
decision. Correction text and all retrieved memory are treated as untrusted
data throughout: neither can issue instructions or grant approval authority.

## Lifecycle

```
pending_validation --runValidation--> validated --approve--> applying --> applied
        |                    |
        `---------> needs_changes <---(reject/requestChanges from any
        |                    |          non-terminal state)
        `---------> rejected (terminal)
```

`applied` and `rejected` are terminal: no further transition is possible.
`applying` is a transient claim state — `approve()` sets it atomically
before calling the (potentially slow) mutation apply step, so two concurrent
approvals can never both apply the same mutation; on failure it reverts to
`validated` so the candidate stays retryable.

## Diagnosis

`diagnoseCorrection` classifies the root cause by checking whether the
disputed memory was present _and applicable_ in the retrieval manifest
(`MemoryTrace.applicability`, from [institutional memory](institutional-memory.md)'s
deterministic gateway) recorded at the time of the original response:

- **knowledge_gap** — no disputed memory was identified at all.
- **procedure_fault** — the approved material existed but the applicability
  gateway excluded it, or it was never evaluated during retrieval planning.
- **stale_position** — the material was surfaced and applicable, but its
  review has expired.
- **duplicate_conflict** — two or more disputed records share an identical
  role and applicability scope signature (not merely an overlapping
  condition value, which would misclassify unrelated records).
- **ambiguous** — none of the above apply deterministically. Ambiguous
  corrections never produce a mutation; they stay queued for a human
  decision.

## Mutation, validation, and replay

`proposeCandidateMutation` produces the smallest `create` / `supersede` /
`retire` / `route_adjustment` mutation for the diagnosed cause.
`validateCandidateStructure` reuses `validateInstitutionalMemories` to
reject invalid references, cycles, duplicate IDs, missing provenance, and
scope violations against the _resulting_ institutional set.
`computeImpactedMemoryIds` additionally surfaces which other records
reference the mutation's target via `dependsOnPositionIds`/`positionIds`/
`procedureIds`, for reviewer visibility before approving a supersede/retire.

A candidate only reaches `validated` after a `ReplayGate` passes.
`TargetedReplayGate` (the shipped implementation) applies the mutation to
the current institutional corpus in memory, serves the result through an
ephemeral read-only provider, and runs a throwaway orchestrator to check two
things: does the correction's own prompt now surface the expected outcome,
and does every previously _applied_ candidate's own prompt still surface its
expected outcome (the regression check). Nothing here touches a real
provider or persists anything.

## Persistence

`CorrectionCandidateStore` is the durable side of the queue.
`PostgresCorrectionCandidateStore` (`remem.correction_candidates`, migration
`0007`) is the shipped implementation: `update()` runs inside a transaction
with `SELECT ... FOR UPDATE`, so a concurrent `update()` on the same
candidate blocks until the first commits or rolls back. This is what makes
review durable and cross-process — a candidate an OpenCode session submits
can be listed, approved, or rejected later from the CLI, in a different
process, against the same row. Without a configured Postgres provider, the
queue falls back to `InMemoryCorrectionCandidateStore`, which is not durable
and not visible across processes.

## Applying an approval

`createProviderApplyMutation` dispatches an approved mutation to the
provider that actually owns it: `create` goes to the first configured
provider with write capability; `update`/`supersede`/`retire` resolve to
whichever provider's `get()` already knows the target id. `route_adjustment`
mutations describe a routing/procedure fix outside memory content and are
rejected — there is nothing for a provider to write.

## Surfaces

- **`memory_submit_correction`** (OpenCode v2 tool, agent-facing): submits a
  correction for the current session. Requires a retrieval trace to already
  exist for the session, since diagnosis needs one.
- **`memory_review_status`** (OpenCode v2 tool, agent-facing, read-only):
  returns a _redacted_ summary (state, root cause, pass/fail flags, audit
  events without free-text detail) — never the untrusted correction text or
  the full proposed memory body.
- **`remem correction-candidates [--state STATE]`** (CLI): lists candidates
  with full detail, for a human operator.
- **`remem correction-review <id> --approve|--reject|--request-changes
[--reason TEXT] [--actor NAME]`** (CLI): records the human decision.

No orchestrator method and no OpenCode tool exposes
`approve`/`reject`/`requestChanges` — those are reachable only through
`CorrectionReviewQueue`'s own API, which only the CLI (and, in principle,
any other out-of-band operator surface) calls.
