import { createHash } from "node:crypto"
import type { CaptureConfig } from "./config.js"
import type { CandidateMemory, SessionObservation } from "./observation.js"
import { containsSensitiveCredential, redactSensitiveText } from "./sensitive-data.js"
import type { MemoryContext } from "./types.js"

export type InvestigationHost = "opencode-v1" | "opencode-v2" | "pi"

export interface ResolvedTaskStep {
  kind: "search" | "read" | "command" | "other"
  summary: string
  path?: string
  command?: string
  errorSignature?: string
}

export interface ResolvedTaskEpisode {
  host: InvestigationHost
  context: MemoryContext
  sessionId: string
  messageId?: string
  goal: string
  outcome: "succeeded" | "failed" | "abandoned"
  steps: readonly ResolvedTaskStep[]
  occurredAt?: string
}

const MAX_STEPS = 8
const MAX_LOCATIONS = 4
const MAX_ERRORS = 3
const MAX_PATH = 200
const MAX_COMMAND = 240
const MAX_FIELD = 200
export const PROCEDURE_CONFIDENCE = 0.82

function stableId(...values: string[]): string {
  const digest = createHash("sha256").update(values.join("\u0000")).digest("hex")
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function boundField(value: string | undefined, max = MAX_FIELD): string | undefined {
  if (!value) return undefined
  const redacted = redactSensitiveText(value).replace(/\s+/gu, " ").trim()
  if (!redacted || containsSensitiveCredential(redacted)) return undefined
  if (redacted.length <= max) return redacted
  return `${redacted.slice(0, Math.max(0, max - 3))}...`
}

function workspaceRelative(path: string | undefined): string | undefined {
  const value = boundField(path, MAX_PATH)
  if (!value) return undefined
  const normalized = value.replace(/\\/gu, "/")
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined
  }
  return value.replace(/^\.\//u, "")
}

function compactLines(episode: ResolvedTaskEpisode): string[] | undefined {
  if (episode.outcome !== "succeeded") return undefined
  const steps = episode.steps.slice(0, MAX_STEPS)
  const rawFields = [
    episode.goal,
    ...steps.flatMap((step) => [step.summary, step.path, step.command, step.errorSignature]),
  ]
  // Reject unsanitized secrets first. boundField then redacts remaining text;
  // the joined-content check below catches secrets that only appear after assembly.
  if (rawFields.some((field) => field && containsSensitiveCredential(field))) return undefined
  const goal = boundField(episode.goal)
  if (!goal) return undefined
  const paths = [
    ...new Set(steps.map((step) => workspaceRelative(step.path)).filter((path) => path)),
  ]
  const searches = [
    ...new Set(
      steps
        .filter((step) => step.kind === "search")
        .map((step) => boundField(step.summary))
        .filter((value) => value),
    ),
  ]
  const commands = [
    ...new Set(steps.map((step) => boundField(step.command, MAX_COMMAND)).filter((value) => value)),
  ]
  const errors = [
    ...new Set(steps.map((step) => boundField(step.errorSignature)).filter((value) => value)),
  ]
  // Verified success requires a workspace-relative path, or an error signature
  // plus the command that resolved it.
  if (paths.length === 0 && !(errors.length > 0 && commands.length > 0)) return undefined
  // Prefer the first discovered workspace path; otherwise the last successful command.
  const method = paths[0] ?? commands.at(-1)
  const lines = [
    `Goal: ${goal}`,
    ...(method ? [`Method: ${method}`] : []),
    ...paths.slice(0, MAX_LOCATIONS).map((path) => `Location: ${path}`),
    ...searches.slice(0, MAX_LOCATIONS).map((term) => `Search: ${term}`),
    ...commands.slice(0, MAX_LOCATIONS).map((command) => `Command: ${command}`),
    ...errors.slice(0, MAX_ERRORS).map((signature) => `Error: ${signature}`),
  ]
  const summaries = steps
    .map((step) => boundField(step.summary))
    .filter((summary): summary is string => Boolean(summary))
  if (summaries.length > 0) {
    lines.push("Steps:")
    for (const [index, summary] of summaries.entries()) lines.push(`${index + 1}. ${summary}`)
  }
  const content = lines.join("\n")
  return containsSensitiveCredential(content) ? undefined : lines
}

export function observationFromResolvedTask(
  episode: ResolvedTaskEpisode,
): SessionObservation | undefined {
  const lines = compactLines(episode)
  if (!lines) return undefined
  const occurredAt = episode.occurredAt ?? new Date().toISOString()
  const id = episode.messageId
    ? stableId("observation", episode.host, episode.sessionId, episode.messageId, "procedure")
    : stableId("observation", episode.host, episode.sessionId, episode.goal, occurredAt)
  return {
    id,
    kind: "task-resolved",
    context: { ...episode.context, sessionId: episode.sessionId },
    occurredAt,
    source: `remem://${episode.host}/sessions/${encodeURIComponent(episode.sessionId)}/tasks/${encodeURIComponent(episode.messageId ?? id)}`,
    payload: {
      host: episode.host,
      origin: "agent-investigation",
      goal: boundField(episode.goal),
      text: lines.join("\n"),
      ...(episode.messageId ? { messageId: episode.messageId } : {}),
    },
  }
}

export function extractProcedureCandidate(
  observation: SessionObservation,
  config: CaptureConfig,
): CandidateMemory | undefined {
  if (observation.payload.origin !== "agent-investigation") return undefined
  const text = typeof observation.payload.text === "string" ? observation.payload.text.trim() : ""
  if (!text || text.length > config.maxInputCharacters || containsSensitiveCredential(text)) {
    return undefined
  }
  const content = text.slice(0, config.maxCandidateCharacters)
  const goal =
    typeof observation.payload.goal === "string" &&
    !containsSensitiveCredential(observation.payload.goal)
      ? observation.payload.goal
      : content
  const messageId =
    typeof observation.payload.messageId === "string"
      ? observation.payload.messageId
      : observation.id
  return {
    id: stableId("candidate", observation.id),
    observationIds: [observation.id],
    memory: {
      title: `Procedure: ${goal.slice(0, 80)}`,
      content,
      summary: content.slice(0, 320),
      scope: { kind: "project", id: observation.context.projectId },
      type: "procedure",
      confidence: PROCEDURE_CONFIDENCE,
      provenance: [
        {
          source: {
            kind: "session",
            uri: observation.source,
            externalId: messageId,
            observedAt: observation.occurredAt,
            metadata: {
              host: observation.payload.host,
              sessionId: observation.context.sessionId,
              origin: "agent-investigation",
            },
          },
          capturedAt: observation.occurredAt,
          original: true,
          note: "agent-derived procedural evidence, not a user assertion",
        },
      ],
      metadata: {
        capture: {
          observationId: observation.id,
          host: observation.payload.host,
          origin: "agent-investigation",
        },
      },
    },
    confidence: PROCEDURE_CONFIDENCE,
    status: "pending",
    reasons: ["verified successful investigation"],
  }
}
