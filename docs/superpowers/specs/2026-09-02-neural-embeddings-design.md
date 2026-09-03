# Local Neural Embeddings — Design

Resolves: [#1](https://github.com/cgkades/remem/issues/1) — Add real local neural embeddings with hash fallback.

## Problem

Remem's Stage 1 semantic recognition defaults to `LocalHashEmbeddingModel`
(`src/storage/embedding.ts`), a deterministic feature-hashing scheme with a
hand-authored concept map. It works as a zero-dependency fallback but is not a
learned semantic embedding, so it misses paraphrase/low-lexical-overlap recall
(e.g. connecting "what did we do about that AWS auth problem?" to a memory
titled "Bedrock Claude credential passthrough failure").

## Goals

- Add a real local neural embedding model as the default Stage 1 path for
  managed (PostgreSQL-backed) mode, while keeping `LocalHashEmbeddingModel` as
  an always-available, zero-dependency fallback.
- Never let an embedding-backend failure (missing model, blocked download,
  runtime error) break OpenCode prompt execution.
- Make embedding-model identity and dimensions safely versioned so switching
  models cannot silently corrupt similarity comparisons.
- Provide a migration path (re-embedding) for existing memories when the
  configured model changes, without requiring manual intervention by default.

## Non-goals

- Simultaneous support for multiple embedding dimensions in one deployment.
  pgvector columns are fixed-width; "configurable dimension, changed via
  explicit migration" is in scope, "N different dimensions live at once" is
  not.
- A pluggable multi-model registry / bring-your-own-arbitrary-model system.
  This design ships exactly one neural model (`bge-small-en-v1.5`); a more
  general plugin system is future work if a real need arises.
- Publishing model weights as an npm package to route around firewalls via
  the npm registry mirror. Considered and explicitly deferred — the
  local-model-path override covers the air-gapped case with far less ongoing
  packaging/maintenance overhead.
- Distributed/scale-out re-embedding. The background job is bounded and
  rate-limited for a single-instance, single-database deployment, consistent
  with Remem's current operating model.
- A standing background service/daemon/gateway process for idle-time
  re-embedding (i.e. draining the backlog even when OpenCode isn't actively
  being used). Explicitly deferred in favor of hook-triggered draining (see
  below); revisit only if idle-time staleness proves to be a real problem in
  practice.

## Current state (already in place, no changes needed)

- `EmbeddingModel` interface (`src/types.ts:189`) is already decoupled from
  the orchestrator: `{ id: string; dimensions: number; embed(text, signal?):
Promise<number[]> }`.
- `remem.memory_embeddings` and catalog embedding rows already store
  `embedding_model` and `embedding_dimensions` per row
  (`src/providers/postgres.ts`).
- Semantic match queries already filter on both
  (`WHERE me.model = $X AND me.dimensions = $Y`,
  `src/providers/postgres.ts:329`), so rows written by a different model are
  already excluded from semantic scoring rather than wrongly compared. This
  is the safety net the new work builds on, not something it must invent.
- `remem doctor` already has an embedding health-check block
  (`src/cli/doctor.ts:169-177`) to extend.
- The consolidation pipeline (PR #5, `src/consolidation.ts`) already
  implements a batch-claim / run-tracking / failure-recovery pattern for
  exactly this class of problem (safe, bounded, background reconciliation
  work) — the re-embed job reuses this pattern rather than inventing a new
  one.

## Architecture

### New: `BgeSmallEmbeddingModel`

New file `src/storage/embedding-neural.ts`, implementing `EmbeddingModel`:

- `id`: `"bge-small-en-v1.5"`
- `dimensions`: `384`
- `embed(text, signal?)`: runs the quantized ONNX model via
  `@huggingface/transformers`'s feature-extraction pipeline, mean-pooled and
  normalized to match the existing cosine-similarity contract in
  `src/storage/embedding.ts`.

`@huggingface/transformers` (and its transitive `onnxruntime-node` native
binary) is **lazy-loaded via dynamic `import()`** only when the neural
backend is actually selected. The plain/hash-only path never touches this
dependency, so a load failure there (missing platform binary, corrupted
cache) cannot affect the default zero-dependency experience. Any failure to
load the module, download weights, or run inference is caught and falls back
to `LocalHashEmbeddingModel`, logged via the existing `RememLogger`.

Model choice rationale: `bge-small-en-v1.5` is 384-dimensional — the same as
`LocalHashEmbeddingModel` and the current hardcoded schema default — so
adopting it requires **no schema/dimension migration for existing installs**.
It generally benchmarks ahead of `all-MiniLM-L6-v2` on retrieval-style tasks
(the shape of "vague recall") while staying in the same size class
(~33M params, MIT-licensed). Quantized (int8) ONNX weights are used
(~30MB) rather than fp32 (~90MB) to minimize the one-time download.

### Config

New `embedding` block in the parsed config (`src/config.ts`):

```ts
interface EmbeddingConfig {
  backend: "hash" | "neural" // default: "hash" in plain mode, "neural" in managed mode
  modelPath?: string // local override; skips network download entirely when set
}
```

Default resolution: plain (no-Postgres) mode defaults to `"hash"` — no
network dependency, no new package load, matching "no required external API
or telemetry" for the simplest use case. `remem init --mode managed`
defaults new configs to `"neural"`, matching the issue's framing that
learned similarity should be "the normal managed-mode Stage 1 path." Either
mode can override `backend` explicitly.

### Dimension constraint

`PostgresMemoryProvider`'s hardcoded check
(`src/providers/postgres.ts:195-196`, currently
`if (this.embeddingModel.dimensions !== 384) throw ...`) becomes a check
against a **configured** dimension value, set at first init and persisted
(e.g. alongside the existing schema-version bookkeeping). Changing the
configured dimension after the fact requires an explicit migration path (see
below) — this is not simultaneous multi-dimension support, it is "the
hardcoded 384 becomes a deliberate, changeable choice."

Because `bge-small-en-v1.5` is also 384-dim, this change is architectural
groundwork for the future, not something existing users hit on this
rollout.

## Model-change detection & re-embedding

**Trigger: the existing `"prompt"` session hook** (`src/hosts/opencode/v2.ts:154`),
the same hook the capture pipeline (PR #6) already uses for automatic,
zero-setup, in-process work. No cron, no daemon, no gateway, no user action
required after setup:

- On each prompt, a lightweight cooldown check (e.g. "has it been more than
  5 minutes since the last re-embed attempt for this database") decides
  whether to act. This keeps the check itself effectively free on every
  other prompt.
- When the cooldown has elapsed, compare the configured `embedding.backend`/
  model id against what's actually present in `remem.memory_embeddings`/
  catalog embedding rows. A mismatch (different `embedding_model` values
  present, or a dimension change) means some memories are running on stale
  embeddings.
- If there's backlog, claim and process one bounded batch — same
  batch-claim/run-tracking/failure-recovery pattern as the consolidation
  pipeline — **fired off asynchronously and never awaited** in the
  prompt-handling path, so it can add no latency and cannot block or fail a
  live response.
- Repeatedly-failing batches are recorded the same way consolidation records
  run failures, surfaced as a `remem doctor` warning (stuck-job detection),
  not retried forever inline.

`remem doctor` is a **status/reporting surface only** — it reports backlog
size and last-run/failure state, it does not itself trigger anything.

Manual override: a `remem reembed` CLI command runs the same underlying
batch-claim logic immediately and synchronously (with progress output), for
someone who wants it done right now rather than waiting on the next prompt,
or wants to force a re-embed after suspected data issues.

**Known tradeoff, accepted for now:** re-embedding only progresses while
OpenCode is actively receiving prompts. If a model change happens and
OpenCode then sits completely idle, the backlog doesn't drain until the next
prompt arrives. This is intentional — old memories aren't broken while
stale, they just fall back to keyword-only matching (today's existing
behavior) until re-embedded, and draining resumes automatically the moment
OpenCode is used again. A standing background service would remove this
gap but adds real infrastructure (install/consent flow, OS service
management) for a benefit that's about backlog _latency_, not correctness.
Revisit only if this proves to be a real problem in practice.

This satisfies "an embedding backend failure does not break OpenCode prompt
execution" — the failure mode for a model change is graceful degradation
(keyword-only recall for stale rows) that self-heals automatically during
normal use, not a hard error on the live path. Hard errors / explicit user
decisions are reserved for explicit control-plane commands (`remem init`,
`remem reembed`), never the live prompt path.

## Distribution & offline / firewall fallback

`remem init --mode managed` prints an explicit warning before the first
download attempt (approximate size, source domain), then:

1. **Proxy-aware fetch.** The download request respects standard env vars
   (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`) — the
   same plumbing already used for npm installs in
   `tests/opencode-v2.e2e.mjs`. This resolves the common "corporate network
   requires a specific proxy/CA" case transparently.
2. **Local model-path override.** If `embedding.modelPath` is set (or the
   proxy-aware fetch fails and the user is guided to this option), Remem
   loads weights from a local directory and never attempts a network call.
   This is the escape hatch for fully air-gapped/regulated environments —
   someone stages the weights once via an approved channel.
3. **Automatic fail-open to `LocalHashEmbeddingModel`.** If neither of the
   above succeeds, `remem init` completes anyway (does not hard-fail),
   prints a clear actionable message, and `remem doctor` reports the
   degraded state with a `remem embeddings download` retry command.

Weights are cached locally (`~/.cache/remem/models/`, respecting
`XDG_CACHE_HOME`) and are **not bundled in the npm package** — this keeps
the default zero-dependency install lightweight; only managed-mode users who
actually want neural embeddings pay the one-time download cost.

Deliberately not pursued: publishing model weights as their own npm package
to route around firewalls via an already-trusted npm registry mirror. Real
option, but adds ongoing packaging/licensing/publishing overhead
disproportionate to a scenario the local-path override already handles.

## `remem doctor` surface

Extends the existing embedding health check
(`src/cli/doctor.ts:169-177`) to report:

- Active backend (`hash` / `neural`) and model id/dimensions.
- For `neural`: whether weights are present locally, cache path, and
  download status if a fetch is pending/failed.
- Re-embed backlog status: count of stale rows, hook-triggered job
  progress/last-run outcome, and stuck-job warnings if applicable. (Reporting
  only — `remem doctor` never itself triggers re-embedding; see
  "Model-change detection & re-embedding".)

## Testing plan

- Unit tests for `BgeSmallEmbeddingModel`: successful embed, dimension
  contract, and fallback-on-load-failure / fallback-on-inference-failure
  behavior (mocking the dynamic import boundary).
- Unit tests for the dimension-check change in `PostgresMemoryProvider`
  (configured-dimension enforcement, not hardcoded 384).
- Unit tests for model-identity/dimension mismatch detection and the
  re-embed job's batch-claim/failure-recovery behavior, mirroring the
  existing consolidation test patterns.
- Unit tests for the `"prompt"`-hook trigger: cooldown gating (no-op when
  cooldown hasn't elapsed), fire-and-forget behavior (prompt handling
  completes without awaiting the re-embed batch), and that a failing batch
  never propagates an error into the prompt-handling path.
- Evaluation fixtures: paraphrase / low-lexical-overlap recall cases
  (including the AWS/Bedrock example from the issue), demonstrating improved
  recall for `bge-small-en-v1.5` vs. `LocalHashEmbeddingModel` alone.
- Integration test (gated behind `REMEM_TEST_DATABASE_URL`, matching
  existing Postgres integration test conventions): end-to-end model swap
  triggering detection + background re-embed + eventual full semantic
  coverage.

## Documentation plan

Update `docs/configuration.md` / `docs/installation.md` (or a new
`docs/embeddings.md`) covering: model size/dimensions/license (MIT), runtime
requirements (`@huggingface/transformers` + `onnxruntime-node`, platform
binary availability), the managed-mode default and how to override it, the
three-layer offline/firewall fallback behavior, and the re-embed
job/`remem reembed` command.

## Acceptance criteria mapping (from issue #1)

| Issue criterion                                                     | Covered by                                          |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| Learned semantic similarity is the normal managed-mode Stage 1 path | `embedding.backend` default resolution              |
| Feature hashing remains a tested fallback                           | `LocalHashEmbeddingModel` unchanged; fallback tests |
| Eval fixtures show improved recall vs. hashing alone                | Testing plan                                        |
| Embedding backend failure does not break OpenCode prompt execution  | Lazy-load + fail-open at every failure point        |
| Tests cover model identity/dimension mismatch and fallback          | Testing plan                                        |
| Migration/re-embedding strategy when the model changes              | Hook-triggered re-embed job + `remem reembed`       |
| `remem doctor` reports embedding backend/model health               | Doctor surface section                              |
