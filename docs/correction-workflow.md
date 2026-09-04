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
approvals can never both apply the same mutation.

If the mutation apply itself fails, the claim safely reverts to `validated`
and the candidate stays retryable. If the mutation _succeeds_ but the
finalize write (recording `applied`) fails -- a crash, or a transient store
error -- the candidate is deliberately left in `applying` rather than
reverted: reverting would make it retryable, and retrying would call
`applyMutation` a second time for a mutation that already landed (there is
no idempotency key on create/update/supersede). A candidate stuck this way
must be resolved with `CorrectionReviewQueue.recoverStuckApplying` (exposed
via `remem correction-review <id> --recover-validated` if the mutation
never took effect, or `--recover-applied --memory-id <ID>` if a human
confirmed from provider state or logs that it did), using the memory id
reported in the error `approve()` threw.

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
`TargetedReplayGate` (the shipped implementation) checks two things: does
the correction's own prompt now surface the expected outcome, and does
every previously _applied_ candidate's own prompt still surface its
expected outcome (the regression check, capped to the 20 most recently
applied candidates). For **each** scenario it independently loads the
institutional corpus scoped to _that scenario's own context_ (not the
candidate's), applies the mutation to it, serves the result through an
ephemeral read-only provider, and runs a throwaway orchestrator -- built
with the same embedding model production uses, so semantic recognition
during replay matches what will actually serve the corrected memory. Loading
per scenario matters once applied candidates span multiple
projects/workspaces/sessions: a project-scoped mutation is naturally
invisible (via scope filtering) to a regression scenario outside that scope,
and a regression scenario retains its own institutional memory regardless of
what the candidate under test happens to touch. Nothing here touches a real
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
  correction for the current session, then immediately runs
  diagnosis/mutation-proposal/structural-validation/replay via
  `RememOrchestrator.submitCorrection`, since validation is a fully automatic
  pipeline with no human judgment involved. Requires a retrieval trace to
  already exist for the session, since diagnosis needs one. The correction's
  `prompt` is always `trace.prompt` -- the exact request that trace was
  computed for -- never a caller-supplied replacement, so a correction can
  never be diagnosed against a retrieval manifest that doesn't actually
  belong to it. `correctionText`/`expectedOutcome`/`prompt` are capped at
  8000 characters and `disputedMemoryIds` at 100 entries of 512 characters
  each (`CORRECTION_INPUT_LIMITS`), enforced in
  `CorrectionReviewQueue.submit()` itself (not just the tool's input
  schema), since these values are persisted to and later read back from
  durable storage regardless of caller. `RememOrchestrator.runCorrectionValidation`
  re-runs the same pipeline for a candidate already in `pending_validation`
  or `needs_changes` -- e.g. after a human fixes whatever caused
  `needs_changes` -- and is not needed after a plain submission, which
  already validates once.
- **`memory_review_status`** (OpenCode v2 tool, agent-facing, read-only):
  returns a _redacted_ summary (state, root cause, pass/fail flags, audit
  events without free-text detail) — never the untrusted correction text or
  the full proposed memory body.
- **`remem correction-candidates [--state STATE]`** (CLI): lists candidates
  with full detail, for a human operator. Deliberately more permissive than
  `memory_review_status`: a human operator via CLI is a different trust
  boundary than an agent via a tool call.
- **`remem correction-review <id> --approve|--reject|--request-changes|
--recover-validated|--recover-applied|--validate [--reason TEXT]
[--actor NAME] [--memory-id ID]`** (CLI): records the human decision,
  resolves a candidate stuck in `applying`, or (`--validate`) re-runs the
  automatic diagnosis/validation/replay pipeline that `memory_submit_correction`
  already runs once at submission time -- useful after a human fixes
  whatever caused `needs_changes`, or to retry if it never ran for some
  other reason. `--actor` and `--reason` are capped at 255 and 4096
  characters, since they're persisted and later echoed back verbatim by
  `correction-candidates`.
- Both CLI commands only see the primary PostgreSQL provider's institutional
  corpus and providers (matching every other candidate-related CLI command
  in this project). If institutional memory or a mutation's target lives in
  a different configured provider, only a live OpenCode session -- which
  wires every configured provider -- can see or mutate it; the CLI can
  still list/approve/reject the candidate row itself, since that's always
  persisted in the primary provider's own database.

No orchestrator method and no OpenCode tool exposes
`approve`/`reject`/`requestChanges` — those are reachable only through
`CorrectionReviewQueue`'s own API, which only the CLI (and, in principle,
any other out-of-band operator surface) calls.
