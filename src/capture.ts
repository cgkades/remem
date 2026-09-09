import { createHash, randomUUID } from "node:crypto"
import { DeterministicConsolidationPipeline } from "./consolidation.js"
import type { CaptureConfig, RememConfig } from "./config.js"
import type {
  CandidateExtractor,
  CandidateMemory,
  ObservationStore,
  SessionEventKind,
  SessionObservation,
} from "./observation.js"
import { isObservationStore } from "./observation.js"
import {
  extractProcedureCandidate,
  observationFromResolvedTask,
  PROCEDURE_CONFIDENCE,
  type ResolvedTaskEpisode,
} from "./procedure.js"
import { containsSensitiveCredential } from "./sensitive-data.js"
import { withTimeout } from "./timeout.js"
import type { MemoryContext, MemoryProvider, RememLogger } from "./types.js"

export interface UserPromptCapture {
  host: "opencode-v1" | "opencode-v2" | "pi"
  context: MemoryContext
  sessionId: string
  messageId?: string
  text: string
}

const QUOTED_OR_SYNTHETIC_PATTERN = /(^\s*>|```|<memory-|tool[- ]output|source:\s*remem)/imu
const REPORTED_QUOTE_PATTERN =
  /\b(?:said|wrote|reported|mentioned|claimed|told|according to)\b[^"\n“‘]{0,80}(?:"[^"\n]{1,500}"|'[^'\n]{1,500}'|“[^”\n]{1,500}”|‘[^’\n]{1,500}’)/iu
const ATTRIBUTED_CONTENT_PATTERN =
  /\b(?:(?:according to\s+(?:(?:the|this|that|a|an)\s+)?|per\s+(?:the|this|that)\s+)(?:ticket|issue|runbook|document(?:ation)?|docs?|report|message|email|article|source)|(?:the|this|that)\s+(?:ticket|issue|runbook|document(?:ation)?|docs?|report|message|email|article|source)\s+(?:says?|states?|reports?|mentions?|claims?|requires?|recommends?))\b/iu

export interface CaptureClassification {
  kind: SessionEventKind
  confidence: number
  reason: string
}

/**
 * Decides whether a screened user statement is durable enough to capture.
 * Hosts can provide a stronger local/model-backed policy later, while this
 * deterministic policy remains the zero-dependency fallback.
 */
export interface CapturePolicy {
  classify(text: string): CaptureClassification | undefined
}

const DIRECT_REMEMBER_PATTERN =
  /^\s*(?:please\s+)?(?:remember|keep(?:\s+this)?\s+in\s+mind|note|save|store)(?=\s|:|$)\s*(?:that(?=\s|:|$)\s*)?(?::\s*)?/iu
const MAX_CANDIDATES_PER_OBSERVATION = 8
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" })
const NONTERMINAL_ABBREVIATION =
  /(?<![\p{L}\p{N}_])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e)\.$/iu
const PERSON_INITIAL = /(?<![\p{L}\p{N}_])\p{L}\.$/u
const LABELED_INITIAL = /\b(?:answer|case|choice|item|option|phase|plan|step|version)\s+\p{L}\.$/iu
const CORRECTION_PATTERN =
  /^\s*(?:correction|actually|instead|i was wrong|that(?:'s| is) incorrect)\b/iu
const PREFERENCE_PATTERN =
  /\b(?:i prefer|my preference(?: is)?|i(?:'d| would) rather|please always|please never|always use|never use)\b/iu
const DECISION_PATTERN =
  /(?:\bdecision\s*:|\bwe decided\b|\bwe will use\b|\blet(?:'s| us) use\b|\barchitecture decision\b|\blet(?:'s| us)\b|\bwe(?:'re| are) going to\b|\bwe(?:'ll| will)\b|\bgoing forward\b|\bfrom now on\b|\bthe plan is\b|\bswitch to\b|\bmove to\b|\badopt\b)/iu
const FACT_PATTERN =
  /\b(?:is located (?:at|in)|lives in|is stored in|runs on|uses|belongs to|is configured (?:at|in|with)|can be found (?:at|in))\b/iu
const TASK_PATTERN =
  /\b(?:is blocked|is unblocked|is complete|is completed|was fixed|is fixed|was resolved|is resolved)\b/iu

function classifyDurableStatement(text: string): CaptureClassification | undefined {
  if (CORRECTION_PATTERN.test(text)) {
    return { kind: "user-correction", confidence: 0.95, reason: "explicit correction" }
  }
  if (PREFERENCE_PATTERN.test(text)) {
    return { kind: "preference", confidence: 0.9, reason: "durable preference" }
  }
  if (DECISION_PATTERN.test(text)) {
    return { kind: "decision", confidence: 0.85, reason: "implicit decision" }
  }
  if (TASK_PATTERN.test(text)) {
    return { kind: "project-state", confidence: 0.8, reason: "project state" }
  }
  if (FACT_PATTERN.test(text)) {
    return { kind: "fact-discovered", confidence: 0.78, reason: "durable project fact" }
  }
  return undefined
}

export const deterministicCapturePolicy: CapturePolicy = {
  classify(text) {
    const directRequest = DIRECT_REMEMBER_PATTERN.exec(text)
    if (directRequest) {
      const statement = text.slice(directRequest[0].length).trim()
      if (!statement || statement.includes("?")) return undefined
      const classification = classifyDurableStatement(statement)
      return classification
        ? {
            ...classification,
            confidence: 0.98,
            reason: `explicit remember request: ${classification.reason}`,
          }
        : { kind: "fact-discovered", confidence: 0.98, reason: "explicit remember request" }
    }
    if (text.includes("?")) return undefined
    return classifyDurableStatement(text)
  },
}

function title(kind: SessionEventKind, text: string): string {
  const prefix =
    kind === "user-correction"
      ? "User correction"
      : kind === "preference"
        ? "User preference"
        : kind === "fact-discovered"
          ? "Project fact"
          : kind === "project-state" || kind === "task-opened" || kind === "task-resolved"
            ? "Project task"
            : "Explicit decision"
  const subject = text.replace(/\s+/gu, " ").trim().slice(0, 100)
  return subject ? `${prefix}: ${subject}` : prefix
}

function safeToCapture(text: string, config: CaptureConfig): boolean {
  return (
    text.length > 0 &&
    text.length <= config.maxInputCharacters &&
    !containsSensitiveCredential(text) &&
    !QUOTED_OR_SYNTHETIC_PATTERN.test(text) &&
    !REPORTED_QUOTE_PATTERN.test(text) &&
    !ATTRIBUTED_CONTENT_PATTERN.test(text)
  )
}

function stableId(...values: string[]): string {
  const digest = createHash("sha256").update(values.join("\u0000")).digest("hex")
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

export interface CaptureExplanation {
  outcome: "idle" | "excluded" | "pending" | "promoted" | "failed"
  kind?: SessionEventKind
  confidence?: number
  reason?: string
}

export class DeterministicCandidateExtractor implements CandidateExtractor {
  constructor(
    private readonly config: CaptureConfig,
    private readonly policy: CapturePolicy = deterministicCapturePolicy,
  ) {}

  classify(text: string): CaptureClassification | undefined {
    for (const statement of this.statements(text)) return statement.classification
    return undefined
  }

  private *statements(text: string): Generator<{
    content: string
    start: number
    end: number
    classification: CaptureClassification
  }> {
    if (text.length > this.config.maxInputCharacters) return
    let count = 0
    let spanStart = 0
    for (const { segment, index } of sentenceSegmenter.segment(text)) {
      const spanEnd = index + segment.length
      const raw = text.slice(spanStart, spanEnd)
      const trimmed = raw.trimEnd()
      const remaining = text.slice(spanEnd)
      const nextIsListItem = /^\s*(?:[-*]|\d+\.)\s+/u.test(remaining)
      const continuesPersonName =
        PERSON_INITIAL.test(trimmed) &&
        !LABELED_INITIAL.test(trimmed) &&
        /^\s*[\p{Lu}\p{Lt}](?:[\p{L}\p{M}'’-]+|\.)/u.test(remaining)
      // ICU treats newlines and some abbreviations as boundaries. Keep soft-wrapped qualifiers intact.
      if (
        spanEnd < text.length &&
        !nextIsListItem &&
        (!/[.!?]["')\]]?$/u.test(trimmed) ||
          NONTERMINAL_ABBREVIATION.test(trimmed) ||
          continuesPersonName)
      )
        continue
      const offset = spanStart
      spanStart = spanEnd
      const prefix = /^\s*(?:(?:[-*]|\d+\.)\s+)?/u.exec(raw)?.[0] ?? ""
      const statement = raw.slice(prefix.length).trimEnd()
      if (nextIsListItem && statement.endsWith(":")) continue
      const classification = this.policy.classify(statement)
      if (!classification) continue
      const wrapper = DIRECT_REMEMBER_PATTERN.exec(statement)?.[0] ?? ""
      const content = statement.slice(wrapper.length).trim()
      if (!content || content.length > this.config.maxCandidateCharacters) continue
      const start = offset + prefix.length + statement.indexOf(content, wrapper.length)
      yield { content, start, end: start + content.length, classification }
      if (++count >= MAX_CANDIDATES_PER_OBSERVATION) return
    }
  }

  extract(observations: SessionObservation[], _signal?: AbortSignal): Promise<CandidateMemory[]> {
    const candidates: CandidateMemory[] = []
    for (const observation of observations) {
      const procedure = extractProcedureCandidate(observation, this.config)
      if (procedure) {
        candidates.push(procedure)
        continue
      }
      const text = typeof observation.payload.text === "string" ? observation.payload.text : ""
      // Screen the whole input before splitting so quotation/secret context cannot be stripped away.
      if (!safeToCapture(text, this.config)) continue
      const messageId =
        typeof observation.payload.messageId === "string"
          ? observation.payload.messageId
          : observation.id
      let index = 0
      for (const { content, start, end, classification } of this.statements(text)) {
        const type =
          classification.kind === "preference"
            ? "preference"
            : classification.kind === "fact-discovered"
              ? "semantic"
              : classification.kind === "project-state" ||
                  classification.kind === "task-opened" ||
                  classification.kind === "task-resolved"
                ? "task"
                : "decision"
        candidates.push({
          // Preserve the first candidate's identity for previously persisted single-candidate captures.
          id:
            index++ === 0
              ? stableId("candidate", observation.id)
              : stableId("candidate", observation.id, String(start)),
          observationIds: [observation.id],
          memory: {
            title: title(classification.kind, content),
            content,
            summary: content.slice(0, 320),
            scope: { kind: "project", id: observation.context.projectId },
            type,
            confidence: classification.confidence,
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
            metadata: {
              capture: {
                observationId: observation.id,
                host: observation.payload.host,
                extractorVersion: "deterministic-spans-v1",
                statementStart: start,
                statementEnd: end,
              },
            },
          },
          confidence: classification.confidence,
          status: "pending",
          reasons: [classification.reason],
        })
      }
    }
    return Promise.resolve(candidates)
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
  private static readonly maxExplanations = 100
  private readonly explanations = new Map<string, CaptureExplanation>()
  private readonly activeCaptureIds = new Map<string, string>()
  private closed = false

  constructor(
    private readonly store: ObservationStore,
    private readonly config: CaptureConfig,
    private readonly logger: RememLogger,
    private readonly promote?: (candidate: CandidateMemory, signal: AbortSignal) => Promise<void>,
  ) {
    this.extractor = new DeterministicCandidateExtractor(config)
  }

  explain(sessionId: string): CaptureExplanation {
    return this.explanations.get(sessionId) ?? { outcome: "idle" }
  }

  private recordExplanation(sessionId: string, explanation: CaptureExplanation): void {
    this.explanations.delete(sessionId)
    this.explanations.set(sessionId, explanation)
    while (this.explanations.size > CaptureCoordinator.maxExplanations) {
      const oldest = this.explanations.keys().next().value
      if (oldest === undefined) break
      this.explanations.delete(oldest)
    }
  }

  private finishCapture(observation: SessionObservation, explanation?: CaptureExplanation): void {
    const sessionId = observation.context.sessionId
    if (!sessionId || this.activeCaptureIds.get(sessionId) !== observation.id) return
    this.activeCaptureIds.delete(sessionId)
    if (explanation) this.recordExplanation(sessionId, explanation)
  }

  enqueueResolvedTask(episode: ResolvedTaskEpisode): void {
    if (this.closed) return
    if (episode.outcome !== "succeeded") {
      this.activeCaptureIds.delete(episode.sessionId)
      this.recordExplanation(episode.sessionId, {
        outcome: "excluded",
        kind: "task-resolved",
        reason: "investigation was not a verified success",
      })
      return
    }
    const observation = observationFromResolvedTask(episode)
    if (!observation) {
      this.activeCaptureIds.delete(episode.sessionId)
      this.recordExplanation(episode.sessionId, {
        outcome: "excluded",
        kind: "task-resolved",
        reason: "investigation lacked verified path or error-fix evidence",
      })
      return
    }
    if (!extractProcedureCandidate(observation, this.config)) {
      this.activeCaptureIds.delete(episode.sessionId)
      this.recordExplanation(episode.sessionId, {
        outcome: "excluded",
        kind: "task-resolved",
        reason: "capture safety policy excluded the procedure",
      })
      return
    }
    if (this.queue.length >= this.config.queueLimit) {
      logFailure(this.logger, "capture.dropped", { reason: "queue_full" })
      this.activeCaptureIds.delete(episode.sessionId)
      this.recordExplanation(episode.sessionId, {
        outcome: "failed",
        kind: "task-resolved",
        reason: "capture queue is full",
      })
      return
    }
    this.activeCaptureIds.set(episode.sessionId, observation.id)
    this.queue.push(observation)
    this.recordExplanation(episode.sessionId, {
      outcome: "pending",
      kind: "task-resolved",
      confidence: PROCEDURE_CONFIDENCE,
      reason: "verified successful investigation",
    })
    if (!this.drainPromise) this.drainPromise = this.drain()
  }

  enqueue(input: UserPromptCapture): void {
    if (this.closed) return
    const text = input.text.trim()
    const classification = this.extractor.classify(text)
    if (!classification) {
      this.activeCaptureIds.delete(input.sessionId)
      this.recordExplanation(input.sessionId, {
        outcome: "excluded",
        reason: "not a durable statement",
      })
      return
    }
    if (!safeToCapture(text, this.config)) {
      this.activeCaptureIds.delete(input.sessionId)
      this.recordExplanation(input.sessionId, {
        outcome: "excluded",
        kind: classification.kind,
        confidence: classification.confidence,
        reason: "capture safety policy excluded the statement",
      })
      return
    }
    if (this.queue.length >= this.config.queueLimit) {
      logFailure(this.logger, "capture.dropped", { reason: "queue_full" })
      this.activeCaptureIds.delete(input.sessionId)
      this.recordExplanation(input.sessionId, {
        outcome: "failed",
        kind: classification.kind,
        confidence: classification.confidence,
        reason: "capture queue is full",
      })
      return
    }
    const id = input.messageId
      ? stableId("observation", input.host, input.sessionId, input.messageId)
      : randomUUID()
    const source = `remem://${input.host}/sessions/${encodeURIComponent(input.sessionId)}/messages/${encodeURIComponent(input.messageId ?? id)}`
    this.activeCaptureIds.set(input.sessionId, id)
    this.queue.push({
      id,
      kind: classification.kind,
      context: { ...input.context, sessionId: input.sessionId },
      occurredAt: new Date().toISOString(),
      source,
      payload: {
        host: input.host,
        text,
        ...(input.messageId ? { messageId: input.messageId } : {}),
      },
    })
    this.recordExplanation(input.sessionId, {
      outcome: "pending",
      kind: classification.kind,
      confidence: classification.confidence,
      reason: classification.reason,
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
    } finally {
      this.activeCaptureIds.clear()
      this.explanations.clear()
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
          const promote = this.config.autoPromote ? this.promote : undefined
          for (const candidate of candidates) {
            if (promote) {
              const approved = { ...candidate, status: "approved" as const }
              await withTimeout(
                this.config.timeoutMs,
                (signal) => promote(approved, signal),
                this.shutdown.signal,
              )
              continue
            }
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
          this.finishCapture(
            observation,
            promote && candidates.length > 0
              ? {
                  outcome: "promoted",
                  kind: observation.kind,
                  confidence: Math.min(...candidates.map((candidate) => candidate.confidence)),
                  reason:
                    candidates.length > 1
                      ? `captured ${candidates.length} statements`
                      : (candidates[0]?.reasons[0] ?? "captured statement"),
                }
              : undefined,
          )
        } catch (error) {
          this.finishCapture(observation, {
            outcome: "failed",
            kind: observation.kind,
            reason: "capture processing failed",
          })
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
  if (!provider || !isObservationStore(provider)) return undefined
  const pipeline = config.capture.autoPromote
    ? new DeterministicConsolidationPipeline(provider, { batchSize: 1 })
    : undefined
  return new CaptureCoordinator(provider, config.capture, logger, async (candidate, signal) => {
    if (!pipeline) return
    const [result] = await pipeline.consolidate([candidate], signal)
    if (result?.status !== "promoted") throw new Error("automatic capture was not promoted")
  })
}
