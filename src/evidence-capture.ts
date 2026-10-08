import type { RememConfig } from "./config.js"
import {
  admitEvidence,
  type AdmissionAuthority,
  type EvidenceAdmissionConfig,
  type EvidenceEnvelope,
  type RawEvidenceCandidate,
} from "./observation-admission.js"
import { isCapacityStore, isEpisodicStore, type EpisodicStore } from "./observation.js"
import { withTimeout } from "./timeout.js"
import type { MemoryProvider, RememLogger } from "./types.js"

/** Host-neutral evidence queue. Admission precedes all persistence and is
 * independent of semantic significance, legacy capture, and promotion. */
export class EvidenceCaptureCoordinator {
  private readonly queue: EvidenceEnvelope[] = []
  private draining: Promise<void> | undefined
  private closed = false
  private readonly shutdown = new AbortController()

  constructor(
    private readonly store: EpisodicStore,
    private readonly authority: AdmissionAuthority,
    private readonly config: EvidenceAdmissionConfig,
    private readonly timeoutMs: number,
    private readonly logger: RememLogger,
  ) {}

  private diagnostic(reason: string): void {
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
    if (this.closed) return undefined
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
    if (!this.draining) this.draining = this.drain()
    return result.envelope.id
  }

  async idle(): Promise<void> {
    await this.draining
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.shutdown.signal.aborted) {
        const envelope = this.queue.shift()
        if (!envelope) continue
        try {
          await withTimeout(
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
              let persisted = await this.store.appendEvidence(
                replay?.outcome === "admitted" ? replay.envelope : envelope,
                { timeoutMs: this.timeoutMs, signal },
              )
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
                  persisted = await this.store.appendEvidence(retry.envelope, {
                    timeoutMs: this.timeoutMs,
                    signal,
                  })
                }
              }
              if (persisted.outcome === "collision" || persisted.outcome === "forgotten") {
                this.diagnostic(persisted.outcome)
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
            },
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
    this.closed = true
    try {
      await withTimeout(this.timeoutMs, () => this.idle())
    } catch {
      this.shutdown.abort()
      this.queue.length = 0
      this.diagnostic("shutdown-timeout")
    }
  }
}

export function createEvidenceCaptureCoordinator(
  providers: MemoryProvider[],
  config: RememConfig,
  authority: Omit<AdmissionAuthority, "providerId">,
  logger: RememLogger,
): EvidenceCaptureCoordinator | undefined {
  if (!config.evidenceAdmission.enabled) return undefined
  const primary = config.providers.find(
    (provider) => provider.type === "postgres" && provider.primary,
  )
  const store = primary && providers.find((provider) => provider.id === primary.id)
  if (!store || !isEpisodicStore(store)) return undefined
  return new EvidenceCaptureCoordinator(
    store,
    { ...authority, providerId: store.id },
    config.evidenceAdmission,
    config.providerTimeoutMs,
    logger,
  )
}
