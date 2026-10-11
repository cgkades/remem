import type { CandidateLineage } from "./learning-ledger.js"
import type { MemoryContext } from "./types.js"
import { withTimeout } from "./timeout.js"

export const LEARNING_DIAGNOSTIC_LIMIT = 20
export const CAPTURE_GAP_REASONS = [
  "malformed-envelope",
  "invalid-identity-field",
  "unsupported-identity",
  "foreign-scope",
  "origin-not-enabled",
  "too-many-evidence-refs",
  "payload-too-large",
  "payload-too-complex",
  "unscreenable-content",
  "identity-collision",
  "queue-full",
  "replay-rejected",
  "collision",
  "forgotten",
  "persistence-failed",
  "shutdown-timeout",
  "other",
] as const
export type CaptureGapReason = (typeof CAPTURE_GAP_REASONS)[number]
export type CaptureGapHost = "opencode-v1" | "opencode-v2" | "pi" | "other"
export interface LearningHistoryEntry extends CandidateLineage {
  extractorVersion: string
  updatedAt: string
  confidence?: number
}
export interface CaptureGap {
  host: CaptureGapHost
  reason: CaptureGapReason
  count: number
  lastObservedAt: string
}
export interface LearningHistory {
  entries: LearningHistoryEntry[]
  gaps: CaptureGap[]
  /** More lineage rows exist than this bounded response. */
  limited: boolean
}
export interface LearningDiagnosticsStore {
  learningHistory(
    context: MemoryContext,
    options?: { limit?: number; signal?: AbortSignal },
  ): Promise<LearningHistory>
  recordCaptureGap(
    context: MemoryContext,
    gap: Pick<CaptureGap, "host" | "reason" | "count">,
    signal?: AbortSignal,
  ): Promise<void>
}
export function isLearningDiagnosticsStore(value: unknown): value is LearningDiagnosticsStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "learningHistory" in value &&
    typeof value.learningHistory === "function" &&
    "recordCaptureGap" in value &&
    typeof value.recordCaptureGap === "function"
  )
}
/** Single writer with a fixed-size reason map. Failed telemetry is dropped;
 * never recursively records its own error or queues rejected source bodies. */
export class CaptureGapRecorder {
  private readonly pending = new Map<CaptureGapReason, number>()
  private running: Promise<void> | undefined
  private closed = false
  private readonly abort = new AbortController()
  private readonly host: CaptureGapHost
  constructor(
    private readonly store: LearningDiagnosticsStore,
    private readonly context: MemoryContext,
    host: string,
    private readonly timeoutMs: number,
  ) {
    this.host = ["opencode-v1", "opencode-v2", "pi"].includes(host)
      ? (host as CaptureGapHost)
      : "other"
  }
  record(rawReason: string): void {
    if (this.closed) return
    const reason = CAPTURE_GAP_REASONS.find((value) => value === rawReason) ?? "other"
    this.pending.set(reason, Math.min(1_000_000, (this.pending.get(reason) ?? 0) + 1))
    this.running ??= this.flush()
  }
  private async flush(): Promise<void> {
    // Start asynchronously so record() installs running before a synchronous failure.
    await Promise.resolve()
    try {
      while (this.pending.size && !this.abort.signal.aborted) {
        const [reason, count] = this.pending.entries().next().value!
        this.pending.delete(reason)
        try {
          await withTimeout(
            this.timeoutMs,
            (signal) =>
              this.store.recordCaptureGap(this.context, { host: this.host, reason, count }, signal),
            this.abort.signal,
          )
        } catch {
          /* Telemetry outage must never affect admission or dispatch. */
        }
      }
    } finally {
      this.running = undefined
    }
  }
  async idle(): Promise<void> {
    await this.running
  }
  async dispose(): Promise<void> {
    this.closed = true
    try {
      await withTimeout(this.timeoutMs, () => this.idle())
    } catch {
      this.abort.abort()
      this.pending.clear()
    }
  }
}
