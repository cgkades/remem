import { createProviderApplyMutation } from "./correction-apply.js"
import { createInstitutionalLoaders } from "./correction-institutional.js"
import { CorrectionReviewQueue, type CorrectionCandidateStore } from "./correction.js"
import type { OrchestratorConfig } from "./config.js"
import { TargetedReplayGate } from "./replay-gate.js"
import type { EmbeddingModel, MemoryProvider } from "./types.js"

/**
 * Assembles a complete `CorrectionReviewQueue` against a set of live
 * providers: institutional-corpus loaders, a provider-backed `ApplyMutation`,
 * and a `TargetedReplayGate` wired to the queue's own applied-candidate
 * history for its regression check. Shared by every host (OpenCode plugin,
 * CLI) so the wiring -- including the queue/replay-gate forward reference,
 * which only this function needs to know about -- exists in exactly one
 * place.
 */
export function createCorrectionReviewQueue(
  store: CorrectionCandidateStore,
  providers: MemoryProvider[],
  config: OrchestratorConfig,
  embeddingModel?: EmbeddingModel,
): CorrectionReviewQueue {
  const { loadInstitutional, loadInstitutionalWrites } = createInstitutionalLoaders(providers)
  // Forward reference: the replay gate needs to list candidates from the
  // queue it will be constructed into.
  // eslint-disable-next-line prefer-const
  let queue: CorrectionReviewQueue
  const replayGate = new TargetedReplayGate(
    config,
    loadInstitutionalWrites,
    () => queue.list({ state: "applied" }),
    embeddingModel,
  )
  queue = new CorrectionReviewQueue(
    store,
    loadInstitutional,
    loadInstitutionalWrites,
    createProviderApplyMutation(providers),
    replayGate,
  )
  return queue
}
