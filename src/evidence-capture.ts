import type { CaptureConfig, RememConfig } from "./config.js"
import {
  EVIDENCE_REFLECTION_VERSION,
  isEvidenceReflectionStore,
  extractRetainedCanonicalEvidence,
} from "./evidence-reflection.js"
import { LEARNING_POLICY_VERSION } from "./learning-policy.js"
import {
  admitEvidence,
  type AdmissionAuthority,
  type EvidenceAdmissionConfig,
  type EvidenceEnvelope,
  type RawEvidenceCandidate,
} from "./observation-admission.js"
import {
  isCapacityStore,
  isEpisodicStore,
  isObservationStore,
  type EpisodicStore,
} from "./observation.js"
import { withTimeout } from "./timeout.js"
import type { MemoryContext, MemoryProvider, RememLogger } from "./types.js"
import { CaptureGapRecorder, isLearningDiagnosticsStore } from "./learning-diagnostics.js"

/** Host-neutral evidence queue. Admission precedes all persistence and is
 * independent of semantic significance and promotion. */
export class EvidenceCaptureCoordinator {
  private readonly queue: EvidenceEnvelope[] = []
  private draining: Promise<void> | undefined
  private closed = false
  private disposing = false
  private readonly shutdown = new AbortController()
  private readonly gaps: CaptureGapRecorder | undefined
  private reflectionPromise:
    Promise<{ selected: number; processed: number; failed: number }> | undefined
  private reflectionContext: MemoryContext | undefined

  constructor(
    private readonly store: EpisodicStore,
    private readonly authority: AdmissionAuthority,
    private readonly config: EvidenceAdmissionConfig,
    private readonly timeoutMs: number,
    private readonly logger: RememLogger,
    private readonly onPersisted?: (
      envelope: EvidenceEnvelope,
      signal: AbortSignal,
    ) => void | Promise<void>,
    private readonly reflectionConfig?: CaptureConfig,
  ) {
    this.gaps = isLearningDiagnosticsStore(store)
      ? new CaptureGapRecorder(
          store,
          { directory: "", worktree: "", projectId: authority.projectId },
          authority.host,
          timeoutMs,
        )
      : undefined
  }

  private diagnostic(reason: string): void {
    this.gaps?.record(reason)
    try {
      void Promise.resolve(
        this.logger.log("warn", "evidence.capture_gap", {
          reason,
          host: this.authority.host,
          count: 1,
        }),
      ).catch(() => undefined)
    } catch {
      // Observability cannot break a host turn.
    }
  }

  enqueue(candidate: RawEvidenceCandidate): string | undefined {
    if (this.closed || this.disposing) return undefined
    const result = admitEvidence(candidate, this.authority, this.config)
    if (result.outcome !== "admitted") {
      if (result.outcome === "rejected") this.diagnostic(result.reason)
      return undefined
    }
    if (this.queue.length >= this.config.maxQueuedEvents) {
      this.diagnostic("queue-full")
      return undefined
    }
    this.queue.push(result.envelope)
    this.reflectionContext = result.envelope.context
    if (!this.draining) this.draining = this.drain()
    return result.envelope.id
  }

  async idle(): Promise<void> {
    await this.draining
    await this.reflectionPromise
    await this.gaps?.idle()
  }

  reflect(
    context: MemoryContext,
    parentSignal?: AbortSignal,
  ): Promise<{ selected: number; processed: number; failed: number }> {
    parentSignal?.throwIfAborted()
    if (this.reflectionPromise) return this.reflectionPromise
    const store = this.store
    const capture = this.reflectionConfig
    if (
      this.closed ||
      !capture?.enabled ||
      !this.config.enabled ||
      !isEvidenceReflectionStore(store) ||
      !isObservationStore(store)
    )
      return Promise.resolve({ selected: 0, processed: 0, failed: 0 })
    this.reflectionContext = context
    const version = `${EVIDENCE_REFLECTION_VERSION}:${LEARNING_POLICY_VERSION}:${capture.autoPromote ? "auto" : "review"}`
    const report = { selected: 0, processed: 0, failed: 0 }
    this.reflectionPromise = withTimeout(
      Math.min(5000, Math.max(100, this.timeoutMs)),
      async (signal) => {
        await this.draining
        signal.throwIfAborted()
        const claims = await store.claimEvidenceExtraction(
          context,
          this.authority.host,
          this.config.enabledOrigins,
          version,
          signal,
        )
        report.selected = claims.length
        for (const claim of claims) {
          signal.throwIfAborted()
          const admitted = admitEvidence(claim.envelope, this.authority, this.config)
          if (
            admitted.outcome !== "admitted" ||
            admitted.envelope.contentHash !== claim.envelope.contentHash
          ) {
            report.failed++
            continue
          }
          try {
            await extractRetainedCanonicalEvidence(
              store as typeof store & MemoryProvider,
              admitted.envelope,
              capture,
              signal,
            )
            if (await store.finishEvidenceExtraction(claim, version, signal)) report.processed++
            else report.failed++
          } catch (error) {
            if (signal.aborted) throw error
            report.failed++
          }
        }
        return report
      },
      parentSignal ?? this.shutdown.signal,
    )
      .catch((error: unknown) => {
        if (parentSignal?.aborted) throw error
        report.failed++
        return report
      })
      .finally(() => {
        this.reflectionPromise = undefined
        try {
          void Promise.resolve(
            this.logger.log("debug", "evidence.reflection", { ...report }),
          ).catch(() => undefined)
        } catch {
          /* Diagnostics never block a host. */
        }
      })
    return this.reflectionPromise
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.shutdown.signal.aborted) {
        const envelope = this.queue.shift()
        if (!envelope) continue
        try {
          const persistedEnvelope = await withTimeout(
            this.timeoutMs,
            async (signal) => {
              // The pinned host callbacks have IDs but no timestamp. Keep
              // the first ingestion time on replay (including after restart)
              // rather than turn a duplicate callback into a hash collision.
              const existing = await this.store.readEvidence(
                this.authority.providerId,
                envelope.id,
                envelope.context,
              )
              signal.throwIfAborted()
              const replay = existing
                ? admitEvidence(
                    { ...envelope, occurredAt: existing.occurredAt },
                    this.authority,
                    this.config,
                  )
                : undefined
              if (replay && replay.outcome !== "admitted") {
                this.diagnostic("replay-rejected")
                return
              }
              let admitted = replay?.outcome === "admitted" ? replay.envelope : envelope
              let persisted = await this.store.appendEvidence(admitted, {
                timeoutMs: this.timeoutMs,
                signal,
              })
              // Two processes can both observe a first delivery before
              // either append commits. Re-read once after a collision so
              // differing ingestion clocks don't turn identical evidence
              // into a false collision. Changed evidence still collides.
              if (persisted.outcome === "collision" && !existing) {
                const winner = await this.store.readEvidence(
                  this.authority.providerId,
                  envelope.id,
                  envelope.context,
                )
                signal.throwIfAborted()
                const retry =
                  winner &&
                  admitEvidence(
                    { ...envelope, occurredAt: winner.occurredAt },
                    this.authority,
                    this.config,
                  )
                if (retry?.outcome === "admitted") {
                  admitted = retry.envelope
                  persisted = await this.store.appendEvidence(retry.envelope, {
                    timeoutMs: this.timeoutMs,
                    signal,
                  })
                }
              }
              if (persisted.outcome === "collision" || persisted.outcome === "forgotten") {
                this.diagnostic(persisted.outcome)
                return
              }
              // Reuse the approved bounded compaction/hard-limit policy.
              // Do not invent an age-based deletion path.
              if (persisted.outcome === "appended" && isCapacityStore(this.store)) {
                signal.throwIfAborted()
                await this.store.enforceCapacity(
                  this.authority.providerId,
                  envelope.context.projectId,
                )
              }
              signal.throwIfAborted()
              return admitted
            },
            this.shutdown.signal,
          )
          if (persistedEnvelope && !this.shutdown.signal.aborted)
            await withTimeout(
              this.timeoutMs,
              async (signal) => this.onPersisted?.(persistedEnvelope, signal),
              this.shutdown.signal,
            )
        } catch {
          this.diagnostic("persistence-failed")
        }
      }
    } finally {
      this.draining = undefined
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true
    if (this.reflectionContext) {
      try {
        await this.reflect(this.reflectionContext)
      } catch {
        this.diagnostic("reflection-interrupted")
      }
    }
    this.closed = true
    try {
      await withTimeout(this.timeoutMs, () => this.idle())
    } catch {
      this.shutdown.abort()
      this.queue.length = 0
      this.diagnostic("shutdown-timeout")
    } finally {
      await this.gaps?.dispose()
    }
  }
}

export function createEvidenceCaptureCoordinator(
  providers: MemoryProvider[],
  config: RememConfig,
  authority: Omit<AdmissionAuthority, "providerId">,
  logger: RememLogger,
  onPersisted?: (envelope: EvidenceEnvelope, signal: AbortSignal) => void | Promise<void>,
): EvidenceCaptureCoordinator | undefined {
  if (!config.evidenceAdmission.enabled) return undefined
  const primary = config.providers.find(
    (provider) => provider.type === "postgres" && provider.primary,
  )
  const store = primary && providers.find((provider) => provider.id === primary.id)
  if (!store || !isEpisodicStore(store)) {
    try {
      void Promise.resolve(
        logger.log("warn", "evidence.capture_gap", {
          host: authority.host,
          reason: "no-primary-episodic-store",
          count: 1,
        }),
      ).catch(() => undefined)
    } catch {
      // Observability cannot break host initialization.
    }
    return undefined
  }
  return new EvidenceCaptureCoordinator(
    store,
    { ...authority, providerId: store.id },
    config.evidenceAdmission,
    config.providerTimeoutMs,
    logger,
    onPersisted,
    config.capture,
  )
}
