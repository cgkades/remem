import { createHash } from "node:crypto"
import type { CaptureConfig } from "./config.js"
import { DeterministicCandidateExtractor, deterministicCapturePolicy } from "./capture.js"
import { DeterministicConsolidationPipeline } from "./consolidation.js"
import type { EvidenceEnvelope, EvidenceOrigin } from "./observation-admission.js"
import type { EpisodicStore, ObservationStore, SessionObservation } from "./observation.js"
import { observationFromResolvedTask } from "./procedure.js"
import { verifiedProcedureFromEvidence, type ProcedureEvidenceStore } from "./verified-procedure.js"
import type { MemoryContext, MemoryProvider } from "./types.js"
export const EVIDENCE_REFLECTION_VERSION = "canonical-reflection-v1"
export interface EvidenceExtractionClaim {
  envelope: EvidenceEnvelope
  token: string
}
export interface EvidenceReflectionStore {
  claimEvidenceExtraction(
    context: MemoryContext,
    host: string,
    origins: readonly EvidenceOrigin[],
    version: string,
    signal?: AbortSignal,
  ): Promise<EvidenceExtractionClaim[]>
  finishEvidenceExtraction(
    claim: EvidenceExtractionClaim,
    version: string,
    signal?: AbortSignal,
  ): Promise<boolean>
  reflectionStatus(context: MemoryContext): Promise<{ unprocessed: number; claimed: number }>
}
export function isEvidenceReflectionStore(value: unknown): value is EvidenceReflectionStore {
  return (
    !!value &&
    typeof value === "object" &&
    "claimEvidenceExtraction" in value &&
    typeof value.claimEvidenceExtraction === "function" &&
    "finishEvidenceExtraction" in value &&
    typeof value.finishEvidenceExtraction === "function" &&
    "reflectionStatus" in value &&
    typeof value.reflectionStatus === "function"
  )
}
function stableId(...values: string[]): string {
  const digest = createHash("sha256").update(values.join("\u0000")).digest("hex")
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}
/** Replay uses the same extractor, verifier, server policy and atomic pipeline.
 * It never invents model conclusions or requires the old transcript. */
export async function extractRetainedCanonicalEvidence(
  store: MemoryProvider & ObservationStore & EpisodicStore,
  envelope: EvidenceEnvelope,
  config: CaptureConfig,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  let observation: SessionObservation | undefined
  if (
    envelope.role === "user" &&
    envelope.origin === "direct-user" &&
    envelope.context.sessionId &&
    envelope.payload.text
  ) {
    const text = envelope.payload.text.trim()
    const classification = deterministicCapturePolicy.classify(text)
    if (!classification) return
    const messageId = envelope.messageId ?? envelope.id
    const id = stableId("observation", envelope.host, envelope.context.sessionId, messageId)
    observation = {
      id,
      kind: classification.kind,
      context: envelope.context,
      occurredAt: envelope.occurredAt,
      source: `remem://${envelope.host}/sessions/${encodeURIComponent(envelope.context.sessionId)}/messages/${encodeURIComponent(messageId)}`,
      payload: {
        host: envelope.host,
        text,
        messageId,
        evidenceRefs: [{ providerId: envelope.providerId, eventId: envelope.id }],
      },
    }
  } else if (
    envelope.role === "tool" &&
    envelope.origin === "host-observed" &&
    "readProcedureEvidenceWindow" in store &&
    typeof store.readProcedureEvidenceWindow === "function"
  ) {
    const window = await (
      store as MemoryProvider & ProcedureEvidenceStore
    ).readProcedureEvidenceWindow(envelope.providerId, envelope.id, envelope.context)
    signal.throwIfAborted()
    const episode = verifiedProcedureFromEvidence(window, envelope.context)
    if (episode) observation = observationFromResolvedTask(episode)
  }
  if (!observation) return
  const candidates = await new DeterministicCandidateExtractor(config).extract(
    [observation],
    signal,
  )
  for (const candidate of candidates) {
    signal.throwIfAborted()
    const receipt = await store.persistCandidate(observation, candidate, {
      signal,
      timeoutMs: config.timeoutMs,
      applyLearningPolicy: true,
      autoApprove: config.autoPromote,
    })
    if (receipt?.status === "approved" && config.autoPromote) {
      const result = await new DeterministicConsolidationPipeline(store, {
        batchSize: 1,
      }).consolidate([{ ...candidate, status: "approved" }], signal)
      if (result[0]?.status !== "promoted") throw new Error("reflection promotion incomplete")
    }
  }
}
