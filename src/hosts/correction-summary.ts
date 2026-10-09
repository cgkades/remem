import type { CorrectionCandidate } from "../correction.js"
import { redactSensitiveText } from "../sensitive-data.js"

const bounded = (text: string): string => redactSensitiveText(text).slice(0, 160)
const ids = (values: string[]): string[] => values.slice(0, 20).map(bounded)

/**
 * Projects a CorrectionCandidate down to state/diagnosis metadata only.
 * Deliberately omits `correction.correctionText`/`expectedOutcome`/`prompt`
 * (untrusted free text), `mutation.proposed` (the full candidate memory
 * body), and free-text audit/reviewer `detail`/`reason` fields, since an
 * agent reading this tool's output should learn what state a candidate is
 * in without absorbing the untrusted content the correction workflow is
 * built to keep inert.
 */
export function redactCandidateSummary(candidate: CorrectionCandidate) {
  return {
    id: candidate.id,
    state: candidate.state,
    rootCause: candidate.rootCause,
    rootCauseReason: candidate.rootCauseReason ? bounded(candidate.rootCauseReason) : undefined,
    affectedMemoryIds: ids(candidate.affectedMemoryIds),
    mutationKind: candidate.mutation?.kind,
    structuralValidation: candidate.structuralValidation
      ? {
          valid: candidate.structuralValidation.valid,
          issueCodes: candidate.structuralValidation.issues
            .slice(0, 20)
            .map((issue) => bounded(issue.code)),
        }
      : undefined,
    replay: candidate.replay
      ? { passed: candidate.replay.passed, caseIds: ids(candidate.replay.caseIds) }
      : undefined,
    audit: candidate.audit.slice(-10).map((entry) => ({
      at: entry.at,
      actor: bounded(entry.actor),
      event: entry.event,
    })),
    reviewerDecision: candidate.reviewerDecision
      ? {
          actor: bounded(candidate.reviewerDecision.actor),
          decision: candidate.reviewerDecision.decision,
        }
      : undefined,
    appliedMemoryId: candidate.appliedMemoryId,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  }
}
