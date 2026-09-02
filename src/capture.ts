import { createHash, randomUUID } from "node:crypto"
import type { CaptureConfig, RememConfig } from "./config.js"
import type {
  CandidateExtractor,
  CandidateMemory,
  ObservationStore,
  SessionEventKind,
  SessionObservation,
} from "./observation.js"
import { isObservationStore } from "./observation.js"
import { containsSensitiveCredential } from "./sensitive-data.js"
import { withTimeout } from "./timeout.js"
import type { MemoryContext, MemoryProvider, RememLogger } from "./types.js"

export interface UserPromptCapture {
  host: "opencode-v1" | "opencode-v2"
  context: MemoryContext
  sessionId: string
  messageId?: string
  text: string
}

const QUOTED_OR_SYNTHETIC_PATTERN = /(^\s*>|```|<memory-|tool[- ]output|source:\s*remem)/imu

function classify(text: string): SessionEventKind | undefined {
  if (text.includes("?")) return undefined
  if (/^\s*(?:correction|actually|instead|i was wrong|that(?:'s| is) incorrect)\b/iu.test(text)) {
    return "user-correction"
  }
  if (/\b(?:i prefer|my preference|always use|never use)\b/iu.test(text)) return "preference"
  if (
    /(?:\bdecision\s*:|\bwe decided\b|\bwe will use\b|\blet(?:'s| us) use\b|\barchitecture decision\b)/iu.test(
      text,
    )
  ) {
    return "decision"
  }
  return undefined
}

function title(kind: SessionEventKind, text: string): string {
  const prefix =
    kind === "user-correction"
      ? "User correction"
      : kind === "preference"
        ? "User preference"
        : "Explicit decision"
  const subject = text.replace(/\s+/gu, " ").trim().slice(0, 100)
  return subject ? `${prefix}: ${subject}` : prefix
}

function safeToCapture(text: string, config: CaptureConfig): boolean {
  return (
    text.length > 0 &&
    text.length <= config.maxInputCharacters &&
    !containsSensitiveCredential(text) &&
    !QUOTED_OR_SYNTHETIC_PATTERN.test(text)
  )
}

function stableId(...values: string[]): string {
  const digest = createHash("sha256").update(values.join("\u0000")).digest("hex")
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

export class DeterministicCandidateExtractor implements CandidateExtractor {
  constructor(private readonly config: CaptureConfig) {}

  extract(observations: SessionObservation[], _signal?: AbortSignal): Promise<CandidateMemory[]> {
    const observation = observations[0]
    const text =
      typeof observation?.payload.text === "string" ? observation.payload.text.trim() : ""
    const kind = classify(text)
    if (!observation || !safeToCapture(text, this.config) || !kind) return Promise.resolve([])
    const messageId =
      typeof observation.payload.messageId === "string"
        ? observation.payload.messageId
        : observation.id
    const content = text.slice(0, this.config.maxCandidateCharacters)
    return Promise.resolve([
      {
        id: stableId("candidate", observation.id),
        observationIds: [observation.id],
        memory: {
          title: title(kind, content),
          content,
          summary: content.slice(0, 320),
          scope: { kind: "project", id: observation.context.projectId },
          type: kind === "preference" ? "preference" : "decision",
          confidence: kind === "user-correction" ? 0.95 : 0.85,
          provenance: [
            {
              source: {
                kind: "user",
                uri: observation.source,
                externalId: messageId,
                observedAt: observation.occurredAt,
                metadata: {
                  host: observation.payload.host,
                  sessionId: observation.context.sessionId,
                  messageId,
                },
              },
              capturedAt: observation.occurredAt,
              original: true,
            },
          ],
          metadata: { capture: { observationId: observation.id, host: observation.payload.host } },
        },
        confidence: kind === "user-correction" ? 0.95 : 0.85,
        status: "pending",
        reasons: [`explicit ${kind}`],
      },
    ])
  }
}

function logFailure(logger: RememLogger, event: string, data?: Record<string, unknown>): void {
  try {
    void Promise.resolve(logger.log("warn", event, data)).catch(() => undefined)
  } catch {
    // Capture is never allowed to affect OpenCode dispatch.
  }
}

export class CaptureCoordinator {
  private readonly extractor: DeterministicCandidateExtractor
  private readonly queue: SessionObservation[] = []
  private drainPromise: Promise<void> | undefined
  private readonly shutdown = new AbortController()
  private closed = false

  constructor(
    private readonly store: ObservationStore,
    private readonly config: CaptureConfig,
    private readonly logger: RememLogger,
  ) {
    this.extractor = new DeterministicCandidateExtractor(config)
  }

  enqueue(input: UserPromptCapture): void {
    if (this.closed) return
    const text = input.text.trim()
    const kind = classify(text)
    if (!kind || !safeToCapture(text, this.config)) return
    if (this.queue.length >= this.config.queueLimit) {
      logFailure(this.logger, "capture.dropped", { reason: "queue_full" })
      return
    }
    const id = input.messageId
      ? stableId("observation", input.host, input.sessionId, input.messageId)
      : randomUUID()
    const source = `remem://${input.host}/sessions/${encodeURIComponent(input.sessionId)}/messages/${encodeURIComponent(input.messageId ?? id)}`
    this.queue.push({
      id,
      kind,
      context: { ...input.context, sessionId: input.sessionId },
      occurredAt: new Date().toISOString(),
      source,
      payload: {
        host: input.host,
        text,
        ...(input.messageId ? { messageId: input.messageId } : {}),
      },
    })
    if (!this.drainPromise) this.drainPromise = this.drain()
  }

  async idle(): Promise<void> {
    await this.drainPromise
  }

  async dispose(): Promise<void> {
    this.closed = true
    try {
      await withTimeout(this.config.timeoutMs, () => this.idle())
    } catch (error) {
      this.shutdown.abort(error)
      this.queue.length = 0
      logFailure(this.logger, "capture.shutdown_timeout", {
        error: error instanceof Error ? error.name : "unknown error",
      })
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const observation = this.queue.shift()
        if (!observation) continue
        try {
          const candidates = await withTimeout(
            this.config.timeoutMs,
            (signal) => this.extractor.extract([observation], signal),
            this.shutdown.signal,
          )
          for (const candidate of candidates) {
            await withTimeout(
              this.config.timeoutMs,
              (signal) =>
                this.store.persistCandidate(observation, candidate, {
                  timeoutMs: this.config.timeoutMs,
                  signal,
                }),
              this.shutdown.signal,
            )
          }
        } catch (error) {
          logFailure(this.logger, "capture.failed", {
            error: error instanceof Error ? error.name : "unknown error",
          })
        }
      }
    } finally {
      if (this.shutdown.signal.aborted) this.queue.length = 0
      this.drainPromise = undefined
      if (!this.closed && this.queue.length > 0) this.drainPromise = this.drain()
    }
  }
}

export function createCaptureCoordinator(
  providers: MemoryProvider[],
  config: RememConfig,
  logger: RememLogger,
): CaptureCoordinator | undefined {
  if (!config.capture.enabled) return undefined
  const primary = config.providers.find(
    (provider) => provider.type === "postgres" && provider.primary,
  )
  const provider = primary && providers.find((candidate) => candidate.id === primary.id)
  return provider && isObservationStore(provider)
    ? new CaptureCoordinator(provider, config.capture, logger)
    : undefined
}
