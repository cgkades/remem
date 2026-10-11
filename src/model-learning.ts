import type { LocalLearningModelConfig, RememConfig } from "./config.js"
import { DeterministicCandidateExtractor } from "./capture.js"
import { parseConfig } from "./config.js"
import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type EvidenceEnvelope,
} from "./observation-admission.js"
import { isObservationStore, type ObservationStore } from "./observation.js"
import { modelProposalCandidate, parseModelProposals } from "./model-proposal.js"
import { LocalGenerationWorker, type LocalGenerator } from "./storage/local-generation.js"
import { withTimeout } from "./timeout.js"
import type { MemoryContext, MemoryProvider, RememLogger } from "./types.js"
export interface ModelLearningStore extends ObservationStore {
  readModelEvidenceWindow(context: MemoryContext, signal?: AbortSignal): Promise<EvidenceEnvelope[]>
}
export class ModelLearningCoordinator {
  private readonly queue: MemoryContext[] = []
  private draining: Promise<void> | undefined
  private readonly shutdown = new AbortController()
  private closed = false
  constructor(
    private readonly store: ModelLearningStore,
    private readonly config: LocalLearningModelConfig,
    private readonly generator: LocalGenerator,
    private readonly logger: RememLogger,
  ) {}
  enqueue(envelope: EvidenceEnvelope): void {
    if (this.closed || !envelope.context.sessionId || this.queue.length >= 4) return
    const context = envelope.context
    if (
      !this.queue.some(
        (c) => c.projectId === context.projectId && c.sessionId === context.sessionId,
      )
    )
      this.queue.push(context)
    if (!this.draining) this.draining = this.drain()
  }
  async idle(): Promise<void> {
    await this.draining
  }
  private async drain(): Promise<void> {
    try {
      while (this.queue.length && !this.shutdown.signal.aborted) {
        const context = this.queue.shift()!
        try {
          await withTimeout(
            this.config.timeoutMs,
            async (signal) => {
              const stored = await this.store.readModelEvidenceWindow(context, signal)
              let evidence = stored
                // Stores deliberately omit machine-local paths. Restore only
                // the authorized caller location, retaining source project/session.
                .map((e) => ({
                  ...e,
                  context: {
                    ...context,
                    projectId: e.context.projectId,
                    sessionId: e.context.sessionId,
                  },
                }))
                .filter((e) => {
                  const admitted = admitEvidence(
                    e,
                    { providerId: e.providerId, host: e.host, projectId: context.projectId },
                    { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
                  )
                  return (
                    admitted.outcome === "admitted" &&
                    admitted.envelope.contentHash === e.contentHash &&
                    e.context.sessionId === context.sessionId &&
                    e.context.projectId === context.projectId
                  )
                })
                .slice(-8)
              const payload = () =>
                JSON.stringify(
                  evidence.map((e, i) => ({
                    id: String(i),
                    role: e.role,
                    origin: e.origin,
                    text: e.payload.text ?? "",
                  })),
                )
              while (evidence.length && Buffer.byteLength(payload()) > 8000)
                evidence = evidence.slice(1)
              if (evidence.length < 2) return
              signal.throwIfAborted()
              const output = await this.generator.generate(payload(), signal)
              signal.throwIfAborted()
              const proposals = parseModelProposals(output.content)
              for (const proposal of proposals) {
                const selected = modelProposalCandidate(proposal, evidence, output.identity)
                // Preserve completed deterministic extraction rather than create a
                // second review copy of an already supported user assertion.
                const direct = proposal.sourceIds
                  .map((id) => evidence[Number(id)]!)
                  .filter((e) => e.role === "user" && e.origin === "direct-user")
                const extractor = new DeterministicCandidateExtractor(
                  parseConfig({
                    capture: { maxInputCharacters: 20000, maxCandidateCharacters: 10000 },
                  }).config.capture,
                )
                let duplicate = false
                for (const source of direct) {
                  const candidates = await extractor.extract([
                    {
                      ...selected.observation,
                      payload: { text: source.payload.text, host: source.host },
                    },
                  ])
                  if (candidates.some((c) => c.memory.content === proposal.content))
                    duplicate = true
                }
                if (duplicate) continue
                signal.throwIfAborted()
                await this.store.persistCandidate(selected.observation, selected.candidate, {
                  applyLearningPolicy: true,
                  autoApprove: false,
                  signal,
                  timeoutMs: 1000,
                })
              }
            },
            this.shutdown.signal,
          )
        } catch {
          try {
            void Promise.resolve(
              this.logger.log("warn", "learning.model_failed", {
                reason: "unavailable-or-invalid-proposal",
              }),
            ).catch(() => undefined)
          } catch {
            /* No body or model output logs. */
          }
        }
      }
    } finally {
      this.draining = undefined
    }
  }
  async dispose(): Promise<void> {
    this.closed = true
    try {
      await withTimeout(this.config.timeoutMs, () => this.idle())
    } catch {
      this.shutdown.abort()
      this.queue.length = 0
    }
    await this.generator.dispose()
  }
}
export function createModelLearningCoordinator(
  providers: MemoryProvider[],
  config: RememConfig,
  logger: RememLogger,
): ModelLearningCoordinator | undefined {
  if (
    !config.capture.enabled ||
    !config.evidenceAdmission.enabled ||
    !config.learningModel.enabled ||
    !config.learningModel.modelPath
  )
    return undefined
  const primary = config.providers.find((p) => p.type === "postgres" && p.primary)
  const store = providers.find((p) => p.id === primary?.id)
  if (
    !store ||
    !isObservationStore(store) ||
    !("readModelEvidenceWindow" in store) ||
    typeof store.readModelEvidenceWindow !== "function"
  )
    return undefined
  return new ModelLearningCoordinator(
    store as ModelLearningStore,
    config.learningModel,
    new LocalGenerationWorker(config.learningModel),
    logger,
  )
}
