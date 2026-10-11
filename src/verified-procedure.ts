import type { EpisodicStore } from "./observation.js"
import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type EvidenceEnvelope,
} from "./observation-admission.js"
import type { ResolvedTaskEpisode } from "./procedure.js"
import type { MemoryContext } from "./types.js"

export const SHELL_RECOVERY_RULE = "native-shell-recovery-v1"
export const PI_FILE_RECOVERY_RULE = "pi-native-file-recovery-v1"
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
    command !== command.replace(/\s+/gu, " ").trim() ||
    command.includes("\n") ||
    command.includes("\r") ||
    command.includes("\u0000") ||
    [
      (input as Record<string, unknown>).background,
      (result as Record<string, unknown>).timeout,
      (result as Record<string, unknown>).truncated,
    ].some((value) => value !== undefined && value !== false) ||
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
  if (!first || !last || !context.sessionId || !["opencode-v2", "pi"].includes(first.host))
    return undefined
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
  if (first.host === "pi") return verifiedPiFileRecovery(evidence, context)
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

/** Pi exposes read/write completion and content, but no reliable shell exit
 * field. Verify exactly one bounded file check/write/identical read instead. */
function verifiedPiFileRecovery(
  evidence: readonly EvidenceEnvelope[],
  context: MemoryContext,
): ResolvedTaskEpisode | undefined {
  const [failed, action, verified] = evidence.slice(-3)
  if (
    !failed ||
    !action ||
    !verified ||
    new Set([failed.turnId, action.turnId, verified.turnId]).size !== 3 ||
    [failed, action, verified].some(
      (e) => !e.turnId || e.origin !== "host-observed" || e.kind !== "tool-result",
    )
  )
    return undefined
  const f = failed.payload.metadata,
    a = action.payload.metadata,
    v = verified.payload.metadata
  const fi = f?.input,
    ai = a?.input,
    vi = v?.input
  if (
    !fi ||
    typeof fi !== "object" ||
    Array.isArray(fi) ||
    !ai ||
    typeof ai !== "object" ||
    Array.isArray(ai) ||
    !vi ||
    typeof vi !== "object" ||
    Array.isArray(vi)
  )
    return undefined
  const input = fi as Record<string, unknown>,
    write = ai as Record<string, unknown>,
    check = vi as Record<string, unknown>
  const path = input.path,
    content = write.content
  if (
    f?.tool !== "read" ||
    f.status !== "error" ||
    a?.tool !== "write" ||
    a.status !== "completed" ||
    v?.tool !== "read" ||
    v.status !== "completed" ||
    typeof path !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u.test(path) ||
    path.split("/").some((p) => p === ".." || !p) ||
    /(?:password|secret|credential|private|production|\.pem$|\.key$)/iu.test(path) ||
    write.path !== path ||
    check.path !== path ||
    Object.keys(input).length !== 1 ||
    Object.keys(check).length !== 1 ||
    Object.keys(write).some((k) => !["path", "content"].includes(k)) ||
    typeof content !== "string" ||
    !/^[A-Za-z0-9 .:_/-]{1,160}\n?$/u.test(content) ||
    !failed.payload.text?.startsWith("ENOENT:") ||
    verified.payload.text !== content ||
    [failed, action, verified].some((e) => {
      const details = e.payload.metadata?.result
      return (
        details !== undefined &&
        (!details ||
          typeof details !== "object" ||
          Array.isArray(details) ||
          Object.keys(details).length > 0)
      )
    })
  )
    return undefined
  return {
    host: "pi",
    context,
    sessionId: context.sessionId!,
    messageId: verified.id,
    goal: `Recover the missing workspace file: ${path}`,
    outcome: "succeeded",
    occurredAt: verified.occurredAt,
    steps: [
      {
        kind: "read",
        path,
        summary: "Native read reported ENOENT",
        errorSignature: "ENOENT: workspace file was unavailable",
      },
      {
        kind: "other",
        path,
        summary: `Native write completed with bounded contents: ${content.trim()}`,
      },
      {
        kind: "read",
        path,
        summary: "The identical native read returned exactly the written contents",
      },
    ],
    verification: {
      rule: PI_FILE_RECOVERY_RULE,
      evidenceRefs: evidence.map((e) => ({ providerId: e.providerId, eventId: e.id })),
    },
  }
}
