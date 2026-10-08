import {
  admitEvidence,
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  type EvidenceEnvelope,
} from "./observation-admission.js"
import type { EpisodicSearchResult } from "./observation.js"
import type { MemoryContext, MemoryResult } from "./types.js"

// Defense in depth for known poisoning shapes. The context's untrusted-data
// boundary remains required; this is not a general prompt-injection detector.
const UNSAFE_INSTRUCTIONS =
  /<\/?(?:memory-context|system|instructions)>|\bignore (?:all |the )?(?:previous|prior|system) instructions\b|\b(?:reveal|exfiltrate)\b.{0,80}\b(?:secrets?|credentials?|system prompt)\b/isu

/** Automatic recall exposes matched tool evidence only, with no neighbor
 * expansion and no promotion to current truth. Assistant claims and user
 * hypotheses remain searchable in the store but are not automatically
 * presented as conclusions by this first evidence slice. */
export function episodeResults(
  result: EpisodicSearchResult,
  providerId: string,
  context: MemoryContext,
): MemoryResult[] {
  return result.matches.flatMap(({ envelope }) => {
    if (
      envelope.schemaVersion !== 1 ||
      envelope.providerId !== providerId ||
      envelope.context.projectId !== context.projectId ||
      envelope.role !== "tool" ||
      envelope.origin !== "host-observed" ||
      envelope.kind !== "tool-result" ||
      !envelope.context.sessionId ||
      envelope.context.sessionId === context.sessionId
    )
      return []
    const admitted = admitEvidence(
      {
        ...envelope,
        // PostgreSQL intentionally does not reconstruct machine-local
        // directory/worktree fields. Use the authorized request location,
        // preserving the original event's project and session identity.
        context: { ...context, sessionId: envelope.context.sessionId },
      },
      { providerId, host: envelope.host, projectId: context.projectId },
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
    )
    if (admitted.outcome !== "admitted") return []
    const safe = admitted.envelope
    if (safe.id !== envelope.id || safe.contentHash !== envelope.contentHash) return []
    const text = safe.payload.text
    if (!text || UNSAFE_INSTRUCTIONS.test(text)) return []
    const tool = safe.payload.metadata?.tool
    const status = safe.payload.metadata?.status
    if (
      typeof tool !== "string" ||
      tool.startsWith("memory_") ||
      !["completed", "error"].includes(String(status))
    )
      return []
    return [asResult(safe, tool, String(status), text)]
  })
}

function asResult(
  envelope: EvidenceEnvelope,
  tool: string,
  status: string,
  text: string,
): MemoryResult {
  const source = `remem://${envelope.host}/sessions/${encodeURIComponent(envelope.context.sessionId ?? "")}/evidence/${envelope.id}`
  return {
    record: {
      id: envelope.id,
      providerId: envelope.providerId,
      title: `Historical ${tool} result (${status}); not a verified conclusion`,
      content: `Historical tool evidence from ${envelope.occurredAt}. Execution status does not establish a root cause or a successful fix.\n${text}`,
      source,
      scope: { kind: "project", id: envelope.context.projectId },
      type: "episodic",
      freshness: "unknown",
      confidence: 0,
      importance: 0.2,
      provenance: [
        {
          source: {
            kind: "session",
            uri: source,
            providerId: envelope.providerId,
            externalId: envelope.id,
            observedAt: envelope.occurredAt,
          },
          capturedAt: envelope.occurredAt,
          original: true,
          note: "Host-observed tool data, not semantic truth",
        },
      ],
    },
    score: 0.3,
    reasons: ["scoped lexical episodic match; historical tool evidence"],
  }
}
