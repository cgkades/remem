import type { RememConfig } from "./config.js"
import { isEpisodicStore, type EpisodicStore } from "./observation.js"
import {
  admitEvidence,
  type AdmissionAuthority,
  type EvidenceAdmissionConfig,
  type EvidenceEnvelope,
  type RawEvidenceCandidate,
} from "./observation-admission.js"
import { withTimeout } from "./timeout.js"
import type { MemoryProvider, RememLogger } from "./types.js"

export class EvidenceCaptureCoordinator {
  private readonly queue: EvidenceEnvelope[] = []
  private draining: Promise<void> | undefined
  private readonly shutdown = new AbortController()
  private closed = false

  constructor(
    private readonly store: EpisodicStore,
    private readonly authority: AdmissionAuthority,
    private readonly config: EvidenceAdmissionConfig,
    private readonly timeoutMs: number,
    private readonly logger: RememLogger,
    private readonly onPersisted?: (envelope: EvidenceEnvelope) => void,
  ) {}

  get providerId(): string {
    return this.authority.providerId
  }

  private diagnose(reason: string): void {
    try {
      void Promise.resolve(
        this.logger.log("warn", "evidence.capture_gap", {
          host: this.authority.host,
          reason,
          count: 1,
        }),
      ).catch(() => undefined)
    } catch {
      // Diagnostics cannot fail a host turn.
    }
  }

  enqueue(candidate: RawEvidenceCandidate): void {
    if (this.closed) return
    const result = admitEvidence(candidate, this.authority, this.config)
    if (result.outcome !== "admitted") {
      if (result.outcome === "rejected") this.diagnose(result.reason)
      return
    }
    if (this.queue.length >= this.config.maxQueuedEvents) {
      this.diagnose("queue-full")
      return
    }
    this.queue.push(result.envelope)
    if (!this.draining) this.draining = this.drain()
  }

  async idle(): Promise<void> {
    await this.draining
  }

  async dispose(): Promise<void> {
    this.closed = true
    try {
      await withTimeout(this.timeoutMs, () => this.idle())
    } catch (error) {
      this.shutdown.abort(error)
      this.queue.length = 0
      this.diagnose("shutdown-timeout")
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.shutdown.signal.aborted) {
        const envelope = this.queue.shift()
        if (!envelope) continue
        try {
          const persisted = await withTimeout(
            this.timeoutMs,
            async (signal) => {
              // The SDK has no event timestamp. Re-delivery retains the first observation time.
              const existing = await this.store.readEvidence(
                envelope.providerId,
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
                this.diagnose(replay.outcome === "rejected" ? replay.reason : "invalid-replay")
                return undefined
              }
              const admitted = replay?.envelope ?? envelope
              const result = await this.store.appendEvidence(admitted, {
                timeoutMs: this.timeoutMs,
                signal,
              })
              signal.throwIfAborted()
              if (result.outcome === "collision" || result.outcome === "forgotten") {
                this.diagnose(result.outcome)
                return undefined
              }
              return admitted
            },
            this.shutdown.signal,
          )
          if (persisted && !this.shutdown.signal.aborted) this.onPersisted?.(persisted)
        } catch {
          this.diagnose("persistence-failed")
        }
      }
    } finally {
      this.draining = undefined
    }
  }
}

export function createEvidenceCaptureCoordinator(
  providers: MemoryProvider[],
  config: RememConfig,
  authority: Omit<AdmissionAuthority, "providerId">,
  logger: RememLogger,
  onPersisted?: (envelope: EvidenceEnvelope) => void,
): EvidenceCaptureCoordinator | undefined {
  if (!config.evidenceAdmission.enabled) return undefined
  const primary = config.providers.find(
    (provider) => provider.type === "postgres" && provider.primary,
  )
  const provider = primary && providers.find((candidate) => candidate.id === primary.id)
  if (!provider || !provider.capabilities().episodicHistory || !isEpisodicStore(provider)) {
    try {
      void Promise.resolve(
        logger.log("warn", "evidence.capture_unavailable", {
          reason: "no-primary-episodic-store",
        }),
      ).catch(() => undefined)
    } catch {
      // Diagnostics cannot fail host initialization.
    }
    return undefined
  }
  return new EvidenceCaptureCoordinator(
    provider,
    { ...authority, providerId: provider.id },
    config.evidenceAdmission,
    config.providerTimeoutMs,
    logger,
    onPersisted,
  )
}
