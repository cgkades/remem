import type { CandidateMemory, SessionObservation } from "./observation.js"
import type { EvidenceEnvelope } from "./observation-admission.js"
import { admitEvidence, DEFAULT_EVIDENCE_ADMISSION_CONFIG } from "./observation-admission.js"
import { containsSensitiveCredential } from "./sensitive-data.js"
import { PI_FILE_RECOVERY_RULE, verifiedProcedureFromEvidence } from "./verified-procedure.js"

export const LEARNING_POLICY_VERSION = "scoped-evidence-learning-v2"
// Old approvals remain eligible only after full current evidence/policy revalidation.
export const REVALIDATABLE_LEARNING_POLICY_VERSIONS: readonly string[] = [
  "scoped-evidence-learning-v1",
  LEARNING_POLICY_VERSION,
]
export type LearningOutcome = "reject" | "episodic-only" | "auto-promote" | "require-review"
export interface LearningDecision {
  version: typeof LEARNING_POLICY_VERSION
  outcome: LearningOutcome
  reason: string
  rule?: "original-user-assertion-v1" | "missing-file-recovery-v1" | "pi-file-recovery-v1"
  key?: string
}
export interface CaptureReceipt {
  decision: LearningDecision
  status: "pending" | "approved" | "rejected"
}

const HIGH_IMPACT =
  /\b(?:production|credential|security|authorization|compliance|legal|financial|billing|medical|institutional|company policy)\b/iu
const POISON =
  /ignore (?:all |the )?(?:previous|prior) instructions|reveal (?:credentials|secrets)|<memory-|```|^\s*>/imu
const PATH = "([A-Za-z0-9][A-Za-z0-9._/-]{0,159})"
const CHECK = new RegExp(
  `^test -f ${PATH}(?: \\|\\| \\{ printf '[A-Za-z0-9 .:_\\\\/-]{1,80}'; exit 1; \\})?$`,
  "u",
)
const CREATE = new RegExp(`^printf '[A-Za-z0-9 .:_\\\\/-]{1,80}' > ${PATH}$`, "u")

function safePath(path: string): boolean {
  return (
    !path.split("/").some((part) => part === ".." || !part) &&
    !/(?:password|secret|credential|private|production|\.pem$|\.key$)/iu.test(path)
  )
}

/** A static, non-executing command grammar. Unknown commands require review;
 * a model cannot authorize itself by assigning this rule name. */
export function missingFileRecoveryKey(evidence: readonly EvidenceEnvelope[]): string | undefined {
  const failed = evidence.at(-3)
  const action = evidence.at(-2)
  if (!failed || !action) return undefined
  const input = failed.payload.metadata?.input as Record<string, unknown> | undefined
  const actionInput = action.payload.metadata?.input as Record<string, unknown> | undefined
  if (
    !input ||
    !actionInput ||
    typeof input.command !== "string" ||
    typeof actionInput.command !== "string" ||
    (input.workdir !== undefined && input.workdir !== ".") ||
    (actionInput.workdir !== undefined && actionInput.workdir !== ".")
  )
    return undefined
  const path = CHECK.exec(input.command)?.[1]
  const target = CREATE.exec(actionInput.command)?.[1]
  return path && path === target && safePath(path) ? `file-presence:${path}` : undefined
}

export function assertionLearningKey(memory: CandidateMemory["memory"]): string {
  const text = memory.content.toLowerCase().replace(/\s+/gu, " ").trim()
  const state =
    /^(.+?) (?:is blocked|is unblocked|is complete|is completed|was fixed|is fixed|was resolved|is resolved)\b/u.exec(
      text,
    )
  const fact =
    /^(.+?) (uses|runs on|is stored in|lives in|is located at|is located in|belongs to|is configured with|is configured at|is configured in)\b/u.exec(
      text,
    )
  return state
    ? `task-state:${state[1]}`
    : fact
      ? `assertion:${fact[1]}:${fact[2]}`
      : `title:${memory.title.toLowerCase()}`
}

/** Pure ordered policy. Persistence must separately establish that the
 * extracted body actually matches its stored sources before using a verdict. */
export function decideLearning(input: {
  candidate: CandidateMemory
  observation: SessionObservation
  evidence: readonly EvidenceEnvelope[]
  autoPromote: boolean
  supportedExtraction: boolean
  hasConflict?: boolean
  now: number
}): LearningDecision {
  const { candidate, observation, evidence } = input
  const decide = (
    outcome: LearningOutcome,
    reason: string,
    extra: Partial<LearningDecision> = {},
  ): LearningDecision => ({ version: LEARNING_POLICY_VERSION, outcome, reason, ...extra })
  if (
    candidate.memory.scope.kind !== "project" ||
    candidate.memory.scope.id !== observation.context.projectId ||
    containsSensitiveCredential(candidate.memory.content) ||
    POISON.test(candidate.memory.content)
  )
    return decide("reject", "unsafe-or-unauthorized-claim")
  for (const source of evidence) {
    const admitted = admitEvidence(
      { ...source, context: observation.context },
      {
        providerId: evidence[0]!.providerId,
        host: String(observation.payload.host),
        projectId: observation.context.projectId,
      },
      { ...DEFAULT_EVIDENCE_ADMISSION_CONFIG, enabled: true },
    )
    if (
      source.context.projectId !== observation.context.projectId ||
      source.context.sessionId !== observation.context.sessionId ||
      admitted.outcome !== "admitted" ||
      admitted.envelope.id !== source.id ||
      admitted.envelope.contentHash !== source.contentHash
    )
      return decide("reject", "invalid-source-evidence")
  }
  if (!evidence.length) return decide("require-review", "missing-source-evidence")
  if (!input.supportedExtraction) return decide("episodic-only", "unsupported-semantic-claim")
  if (input.hasConflict) return decide("require-review", "conflicting-current-knowledge")
  if (
    candidate.memory.institutional ||
    HIGH_IMPACT.test(candidate.memory.content) ||
    HIGH_IMPACT.test(evidence[0]?.payload.text ?? "") ||
    observation.kind === "user-correction" ||
    candidate.memory.title.startsWith("User correction:")
  )
    return decide("require-review", "sensitive-or-correction-claim")
  if (
    evidence.some(
      (source) =>
        !Number.isFinite(Date.parse(source.occurredAt)) ||
        input.now - Date.parse(source.occurredAt) > 24 * 60 * 60 * 1000 ||
        Date.parse(source.occurredAt) > input.now + 60_000,
    )
  )
    return decide("require-review", "evidence-outside-automatic-learning-window")
  let rule: LearningDecision["rule"]
  let key: string | undefined
  if (observation.payload.verificationRule) {
    const verified = verifiedProcedureFromEvidence(evidence, observation.context)
    if (!verified) return decide("episodic-only", "unverified-procedure")
    if (verified.verification?.rule === PI_FILE_RECOVERY_RULE) {
      rule = "pi-file-recovery-v1"
      key = `file-contents:${verified.steps[0]?.path}`
    } else {
      key = missingFileRecoveryKey(evidence)
      if (!key) return decide("require-review", "procedure-outside-low-risk-rule")
      rule = "missing-file-recovery-v1"
    }
  } else if (
    evidence.every((source) => source.role === "user" && source.origin === "direct-user")
  ) {
    rule = "original-user-assertion-v1"
    key = assertionLearningKey(candidate.memory)
  } else return decide("episodic-only", "unknown-source-authority")
  if (!input.autoPromote)
    return decide("require-review", "automatic-learning-disabled", { rule, key })
  return decide("auto-promote", "supported-low-risk-project-claim", { rule, key })
}
