import type { EpisodicStore } from "./observation.js"
import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type EvidenceEnvelope,
} from "./observation-admission.js"
import type { ResolvedTaskEpisode } from "./procedure.js"
import type { MemoryContext } from "./types.js"

export const SHELL_RECOVERY_RULE = "native-shell-recovery-v1"
export const PROCEDURE_WINDOW_LIMIT = 9

/** Optional host-neutral stored-evidence capability; unsupported providers
 * never substitute a live transcript or model-generated episode. */
export interface ProcedureEvidenceStore extends EpisodicStore {
  readProcedureEvidenceWindow(
    providerId: string,
    triggerId: string,
    context: MemoryContext,
  ): Promise<EvidenceEnvelope[]>
}

function shell(envelope: EvidenceEnvelope) {
  const metadata = envelope.payload.metadata
  const input = metadata?.input
  const result = metadata?.result
  if (
    envelope.role !== "tool" ||
    envelope.origin !== "host-observed" ||
    envelope.kind !== "tool-result" ||
    metadata?.tool !== "shell" ||
    metadata.status !== "completed" ||
    !envelope.turnId ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  )
    return undefined
  const command = (input as Record<string, unknown>).command
  const exit = (result as Record<string, unknown>).exit
  if (
    typeof command !== "string" ||
    !command.trim() ||
    command.length > 240 ||
    (input as Record<string, unknown>).background === true ||
    (result as Record<string, unknown>).timeout === true ||
    (result as Record<string, unknown>).truncated === true ||
    typeof exit !== "number" ||
    !Number.isInteger(exit) ||
    exit < 0 ||
    exit > 255
  )
    return undefined
  // A different cwd or execution mode does not reproduce the same check.
  return { command, exit, input: JSON.stringify(input) }
}

/** Input order must come from the store, with ties/overflow refused there.
 * This verifies an observed check recovery, never a causal root-cause claim
 * or overall task-completion assertion. No command is executed here. */
export function verifiedProcedureFromEvidence(
  evidence: readonly EvidenceEnvelope[],
  context: MemoryContext,
): ResolvedTaskEpisode | undefined {
  if (evidence.length < 4 || evidence.length > PROCEDURE_WINDOW_LIMIT) return undefined
  const first = evidence[0]
  const last = evidence.at(-1)
  if (!first || !last || !context.sessionId || first.host !== "opencode-v2") return undefined
  const ids = new Set<string>()
  for (const source of evidence) {
    if (
      source.host !== first.host ||
      source.providerId !== first.providerId ||
      source.context.projectId !== context.projectId ||
      source.context.sessionId !== context.sessionId ||
      ids.has(source.id)
    )
      return undefined
    ids.add(source.id)
    const admitted = admitEvidence(
      { ...source, context },
      { providerId: first.providerId, host: first.host, projectId: context.projectId },
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
    )
    if (
      admitted.outcome !== "admitted" ||
      admitted.envelope.id !== source.id ||
      admitted.envelope.contentHash !== source.contentHash
    )
      return undefined
  }
  if (
    first.role !== "user" ||
    first.origin !== "direct-user" ||
    first.kind !== "turn-completed" ||
    !first.payload.text ||
    evidence.slice(1).some((source) => source.role !== "tool")
  )
    return undefined
  const [failed, action, verified] = evidence.slice(-3)
  if (!failed || !action || !verified) return undefined
  const failure = shell(failed)
  const fix = shell(action)
  const check = shell(verified)
  if (
    !failure ||
    !fix ||
    !check ||
    failure.exit === 0 ||
    fix.exit !== 0 ||
    check.exit !== 0 ||
    failure.input !== check.input ||
    fix.command === failure.command ||
    !failed.payload.text?.trim() ||
    // Distinct native assistant messages exclude parallel calls from a
    // single message; delivery order alone cannot establish their sequence.
    new Set([failed.turnId, action.turnId, verified.turnId]).size !== 3
  )
    return undefined
  return {
    host: "opencode-v2",
    context,
    sessionId: context.sessionId,
    messageId: verified.id,
    goal: `Recover the failing check: ${failure.command}`,
    outcome: "succeeded",
    occurredAt: verified.occurredAt,
    steps: [
      {
        kind: "command",
        summary: `Check failed with exit ${failure.exit}`,
        command: failure.command,
        errorSignature: failed.payload.text.slice(0, 200),
      },
      {
        kind: "command",
        summary: "Recorded intervening action completed with exit 0",
        command: fix.command,
      },
      {
        kind: "command",
        summary: "The same check subsequently completed with exit 0",
        command: check.command,
      },
    ],
    verification: {
      rule: SHELL_RECOVERY_RULE,
      evidenceRefs: evidence.map((source) => ({
        providerId: source.providerId,
        eventId: source.id,
      })),
    },
  }
}
