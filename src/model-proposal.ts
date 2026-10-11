import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { EvidenceEnvelope } from "./observation-admission.js"
import type { CandidateMemory, SessionObservation } from "./observation.js"
import { containsSensitiveCredential } from "./sensitive-data.js"
export const MODEL_PROPOSAL_VERSION = "local-model-quotes-v1"
export interface ModelProposal {
  content: string
  sourceIds: string[]
  confidence?: number
}
const unsafe =
  /ignore (?:all |the )?(?:previous|prior|system) instructions|reveal (?:credentials|secrets)|<\/?(?:memory|system|instructions)|```/iu
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}
export function parseModelProposals(text: string): ModelProposal[] {
  if (text.length > 8000) throw new TypeError("model-output-limit")
  const raw: unknown = JSON.parse(text)
  if (
    !record(raw) ||
    Object.keys(raw).some((k) => k !== "proposals") ||
    !Array.isArray(raw.proposals) ||
    raw.proposals.length > 3
  )
    throw new TypeError("model-output-schema")
  return raw.proposals.map((p: unknown) => {
    if (
      !record(p) ||
      Object.keys(p).some((k) => !["content", "sourceIds", "confidence"].includes(k)) ||
      typeof p.content !== "string" ||
      p.content.length < 8 ||
      p.content.length > 600 ||
      !Array.isArray(p.sourceIds) ||
      p.sourceIds.length < 1 ||
      p.sourceIds.length > 8 ||
      p.sourceIds.some((id: unknown) => typeof id !== "string" || !/^\d$/u.test(id)) ||
      new Set(p.sourceIds).size !== p.sourceIds.length ||
      (p.confidence !== undefined &&
        (typeof p.confidence !== "number" ||
          !Number.isFinite(p.confidence) ||
          p.confidence < 0 ||
          p.confidence > 1))
    )
      throw new TypeError("model-output-schema")
    if (containsSensitiveCredential(p.content) || unsafe.test(p.content))
      throw new TypeError("unsafe-model-proposal")
    return {
      content: p.content,
      sourceIds: p.sourceIds as string[],
      ...(typeof p.confidence === "number" ? { confidence: p.confidence } : {}),
    }
  })
}
function uuid(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\0")).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
/** Model output selects quotations, not trusted conclusions. All novel claims
 * remain episodic-only; even exact source selections require explicit review. */
export function modelProposalCandidate(
  proposal: ModelProposal,
  evidence: readonly EvidenceEnvelope[],
  identity: string,
) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(identity)) throw new TypeError("model-identity")
  const sources = proposal.sourceIds.map((id) => evidence[Number(id)])
  const first = sources[0]
  if (
    !first ||
    sources.some(
      (e) =>
        !e ||
        e.providerId !== first.providerId ||
        e.host !== first.host ||
        e.context.projectId !== first.context.projectId ||
        e.context.sessionId !== first.context.sessionId ||
        !(
          (e.role === "user" && e.origin === "direct-user") ||
          (e.role === "tool" && e.origin === "host-observed")
        ),
    )
  )
    throw new TypeError("model-source-authority")
  const refs = sources.map((e) => ({ providerId: e!.providerId, eventId: e!.id }))
  const normalized = { ...proposal, sourceIds: refs.map((r) => r.eventId) }
  const id = uuid(
    MODEL_PROPOSAL_VERSION,
    first.providerId,
    first.context.projectId ?? "",
    identity,
    proposal.content,
    ...refs.map((r) => r.eventId),
  )
  const confidence = proposal.confidence ?? 0.5
  const observation: SessionObservation = {
    id,
    kind: "fact-discovered",
    context: first.context,
    occurredAt: sources.at(-1)!.occurredAt,
    source: `remem://local-model/proposals/${id}`,
    payload: {
      host: first.host,
      origin: "model-inferred",
      text: proposal.content,
      evidenceRefs: refs,
      modelProposal: { version: MODEL_PROPOSAL_VERSION, identity, proposal: normalized },
    },
  }
  const candidate: CandidateMemory = {
    id: uuid("candidate", id),
    observationIds: [id],
    status: "pending",
    confidence,
    reasons: ["local model source selection; independent review required"],
    memory: {
      title: `Model proposal: ${proposal.content.slice(0, 80)}`,
      content: proposal.content,
      summary: proposal.content.slice(0, 320),
      type: "semantic",
      scope: { kind: "project", id: first.context.projectId },
      confidence,
      provenance: [
        {
          source: {
            kind: "generated",
            uri: observation.source,
            metadata: {
              host: first.host,
              sessionId: first.context.sessionId,
              evidenceRefs: refs,
              modelIdentity: identity,
              extractorVersion: MODEL_PROPOSAL_VERSION,
            },
          },
          capturedAt: observation.occurredAt,
          original: false,
          note: "Model-selected quotation; not independently established knowledge",
        },
      ],
      metadata: {
        capture: {
          observationId: id,
          host: first.host,
          extractorVersion: MODEL_PROPOSAL_VERSION,
          origin: "model-inferred",
        },
      },
    },
  }
  const quoteBound = sources.every((e) => e!.payload.text?.includes(proposal.content))
  return { observation, candidate, quoteBound }
}
/** Reconstruct the entire proposed body from current canonical rows. Source
 * IDs/marker/confidence cannot authorize promotion or replace lost evidence. */
export function validateModelProposal(
  observation: SessionObservation,
  candidate: CandidateMemory,
  evidence: readonly EvidenceEnvelope[],
): boolean {
  const raw = observation.payload.modelProposal
  if (
    !record(raw) ||
    Object.keys(raw).some((k) => !["version", "identity", "proposal"].includes(k)) ||
    raw.version !== MODEL_PROPOSAL_VERSION ||
    typeof raw.identity !== "string" ||
    !record(raw.proposal) ||
    !Array.isArray(raw.proposal.sourceIds)
  )
    throw new TypeError("model-proposal-schema")
  const ids = raw.proposal.sourceIds
  if (ids.some((id: unknown) => typeof id !== "string" || !evidence.some((e) => e.id === id)))
    throw new TypeError("model-source-unavailable")
  const local = ids.map((id) => String(evidence.findIndex((e) => e.id === id)))
  const proposal = parseModelProposals(
    JSON.stringify({ proposals: [{ ...raw.proposal, sourceIds: local }] }),
  )[0]!
  const expected = modelProposalCandidate(proposal, evidence, raw.identity)
  // Provider metadata may add learning policy/key after authorization.
  const comparable = {
    ...candidate.memory,
    metadata: candidate.memory.metadata
      ? Object.fromEntries(
          Object.entries(candidate.memory.metadata).filter(
            ([k]) => !["learningPolicy", "learningKey"].includes(k),
          ),
        )
      : undefined,
  }
  if (
    candidate.id !== expected.candidate.id ||
    observation.kind !== expected.observation.kind ||
    observation.source !== expected.observation.source ||
    observation.occurredAt !== expected.observation.occurredAt ||
    observation.id !== expected.observation.id ||
    !isDeepStrictEqual(observation.payload, expected.observation.payload) ||
    !isDeepStrictEqual(comparable, expected.candidate.memory)
  )
    throw new TypeError("model-proposal-body-mismatch")
  return expected.quoteBound
}
