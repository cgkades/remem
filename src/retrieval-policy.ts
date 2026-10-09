import {
  applicabilityConditionSatisfied,
  institutionalApplies,
  institutionalReviewStatus,
  isInstitutionalMemory,
} from "./institutional.js"
import type { ApplicabilityDecision, CatalogEntry, MemoryContext, MemoryRecord } from "./types.js"

/**
 * Fixed retrieval policy boundary. Provider output cannot replace this policy or authorize
 * recall. The control plane still owns mandatory record validation, scope and freshness gates.
 */
export function catalogPolicyDecision(
  entry: CatalogEntry,
  context?: MemoryContext,
  prompt?: string,
): ApplicabilityDecision | undefined {
  try {
    const institutional = entry.institutional
    if (institutional === undefined) return undefined
    const reviewStatus = institutionalReviewStatus(institutional)
    if (reviewStatus !== "current") {
      return {
        catalogEntryId: entry.id,
        institutionalId: institutional.id,
        applicable: false,
        reason:
          reviewStatus === "expired"
            ? "institutional review expired"
            : "institutional review is invalid",
      }
    }
    if (!context) {
      return {
        catalogEntryId: entry.id,
        institutionalId: institutional.id,
        applicable: false,
        reason: "applicability context unavailable",
      }
    }
    const applicable = institutionalApplies(institutional, context, prompt)
    const failed = institutional.applicability.conditions.find(
      (condition) => !applicabilityConditionSatisfied(condition, context, prompt),
    )
    return {
      catalogEntryId: entry.id,
      institutionalId: institutional.id,
      applicable,
      reason: applicable
        ? "deterministic applicability conditions passed"
        : `failed deterministic gate ${failed?.id ?? "none"}`,
    }
  } catch {
    return {
      catalogEntryId: entry.id,
      institutionalId: "unavailable",
      applicable: false,
      reason: "retrieval policy evaluation failed",
    }
  }
}

export function catalogPolicyAllows(
  entry: CatalogEntry,
  context: MemoryContext,
  prompt?: string,
): boolean {
  return catalogPolicyDecision(entry, context, prompt)?.applicable !== false
}

export function recalledPolicyAllows(
  record: MemoryRecord,
  context: MemoryContext,
  query: string,
  blockedCatalogIds: ReadonlySet<string>,
): boolean {
  try {
    if (blockedCatalogIds.has(record.id)) return false
    for (const institutional of [record.institutional, record.metadata?.institutional]) {
      if (institutional === undefined) continue
      if (
        !isInstitutionalMemory(institutional) ||
        institutionalReviewStatus(institutional) !== "current" ||
        !institutionalApplies(institutional, context, query)
      ) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}
