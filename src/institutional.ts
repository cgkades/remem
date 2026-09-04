import type {
  InstitutionalMemory,
  InstitutionalPosition,
  InstitutionalProcedure,
  MemoryContext,
  MemoryWrite,
} from "./types.js"
import { tokenize } from "./text.js"

export type InstitutionalValidationCode =
  | "duplicate_id"
  | "missing_authority"
  | "missing_provenance"
  | "missing_source_ref"
  | "invalid_applicability"
  | "invalid_review"
  | "expired"
  | "invalid_position"
  | "invalid_procedure"
  | "missing_reference"
  | "dependency_cycle"

export interface InstitutionalValidationIssue {
  code: InstitutionalValidationCode
  id: string
  message: string
}

export interface InstitutionalValidationResult {
  valid: boolean
  issues: InstitutionalValidationIssue[]
}

export interface InstitutionalValidationOptions {
  asOf?: Date
}

export type InstitutionalReviewStatus = "current" | "expired" | "invalid"

type InstitutionalWrite = Pick<
  MemoryWrite,
  "title" | "content" | "scope" | "type" | "provenance" | "institutional"
>

function hasText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim())
}

function isValidDate(value: unknown): value is string {
  return hasText(value) && Number.isFinite(Date.parse(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(hasText)
}

export function isInstitutionalMemory(value: unknown): value is InstitutionalMemory {
  if (!isRecord(value) || (value.role !== "position" && value.role !== "procedure")) return false
  if (
    typeof value.id !== "string" ||
    !isRecord(value.applicability) ||
    (value.applicability.match !== "all" && value.applicability.match !== "any") ||
    !Array.isArray(value.applicability.conditions) ||
    value.applicability.conditions.length === 0 ||
    !value.applicability.conditions.every(
      (condition) =>
        isRecord(condition) &&
        typeof condition.id === "string" &&
        typeof condition.value === "string" &&
        (condition.kind === "topic" ||
          (condition.kind === "context" &&
            (condition.field === "directory" ||
              condition.field === "worktree" ||
              condition.field === "projectId" ||
              condition.field === "sessionId"))),
    ) ||
    !isRecord(value.review) ||
    typeof value.review.reviewedAt !== "string" ||
    !(typeof value.review.expiresAt === "string" || value.review.expiresAt === null)
  ) {
    return false
  }
  if (value.role === "position") {
    return (
      (hasText(value.owner) || hasText(value.authority)) &&
      isStringArray(value.sourceRefs) &&
      isStringArray(value.boundaryConditions)
    )
  }
  return (
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.every(
      (step) =>
        isRecord(step) && typeof step.id === "string" && typeof step.instruction === "string",
    ) &&
    isStringArray(value.positionIds) &&
    isStringArray(value.requiredEvidence) &&
    isStringArray(value.completionCriteria) &&
    isStringArray(value.escalationConditions)
  )
}

export function institutionalReviewStatus(
  institutional: unknown,
  asOf = Date.now(),
): InstitutionalReviewStatus {
  if (!isInstitutionalMemory(institutional)) return "invalid"
  const review = (institutional as { review?: unknown }).review
  if (typeof review !== "object" || review === null) return "invalid"
  const { reviewedAt, expiresAt } = review as { reviewedAt?: unknown; expiresAt?: unknown }
  const reviewedTimestamp = typeof reviewedAt === "string" ? Date.parse(reviewedAt) : Number.NaN
  if (!Number.isFinite(reviewedTimestamp) || reviewedTimestamp > asOf) return "invalid"
  if (expiresAt === null) return "current"
  if (typeof expiresAt !== "string") return "invalid"
  const timestamp = Date.parse(expiresAt)
  if (!Number.isFinite(timestamp)) return "invalid"
  return timestamp <= asOf ? "expired" : "current"
}

export function institutionalApplies(
  institutional: unknown,
  context: MemoryContext,
  prompt?: string,
): boolean {
  if (!isInstitutionalMemory(institutional)) return false
  const matches = institutional.applicability.conditions.map((condition) => {
    if (condition.kind === "topic") {
      return prompt !== undefined && tokenize(prompt).includes(condition.value.toLowerCase())
    }
    return context[condition.field] === condition.value
  })
  return institutional.applicability.match === "all"
    ? matches.every(Boolean)
    : matches.some(Boolean)
}

function nonEmptyStrings(values: unknown): values is string[] {
  return Array.isArray(values) && values.length > 0 && values.every(hasText)
}

export function procedureContent(memory: InstitutionalMemory): string | undefined {
  if (memory.role !== "procedure") return undefined
  if (!Array.isArray(memory.steps)) return undefined
  return memory.steps.map((step, index) => `${index + 1}. ${step.instruction}`).join("\n")
}

function references(memory: InstitutionalMemory): string[] {
  if (memory.role === "position") return memory.dependsOnPositionIds ?? []
  return [...(memory.positionIds ?? []), ...(memory.procedureIds ?? [])]
}

function validateApplicability(
  memory: InstitutionalMemory,
  issues: InstitutionalValidationIssue[],
): void {
  const { applicability } = memory
  if (
    !applicability ||
    (applicability.match !== "all" && applicability.match !== "any") ||
    !Array.isArray(applicability.conditions) ||
    applicability.conditions.length === 0
  ) {
    issues.push({
      code: "invalid_applicability",
      id: memory.id,
      message: "applicability must contain one or more all/any conditions",
    })
    return
  }
  const conditionIds = new Set<string>()
  for (const condition of applicability.conditions) {
    if (
      !hasText(condition.id) ||
      !hasText(condition.value) ||
      conditionIds.has(condition.id) ||
      (condition.kind !== "context" && condition.kind !== "topic") ||
      (condition.kind === "context" &&
        !["directory", "worktree", "projectId", "sessionId"].includes(condition.field))
    ) {
      issues.push({
        code: "invalid_applicability",
        id: memory.id,
        message: "applicability condition IDs and values must be unique non-empty strings",
      })
      return
    }
    conditionIds.add(condition.id)
  }
}

function validateReview(
  memory: InstitutionalMemory,
  asOf: Date,
  issues: InstitutionalValidationIssue[],
): void {
  const { review } = memory
  if (!review) {
    issues.push({
      code: "invalid_review",
      id: memory.id,
      message: "institutional memories require review information",
    })
    return
  }
  const { reviewedAt, expiresAt } = review
  if (!isValidDate(reviewedAt) || (expiresAt !== null && !isValidDate(expiresAt))) {
    issues.push({
      code: "invalid_review",
      id: memory.id,
      message: "review timestamps must be valid ISO-compatible dates",
    })
    return
  }
  if (expiresAt !== null && Date.parse(expiresAt) <= asOf.getTime()) {
    issues.push({ code: "expired", id: memory.id, message: "institutional memory has expired" })
  }
}

function hasProvenance(memory: InstitutionalWrite): boolean {
  return Boolean(
    memory.provenance?.some(
      ({ source }) => hasText(source.uri) || hasText(source.externalId) || hasText(source.id),
    ),
  )
}

function validateSharedEntry(
  memory: InstitutionalWrite,
  institutional: InstitutionalMemory,
  asOf: Date,
  issues: InstitutionalValidationIssue[],
): void {
  if (!hasText(institutional.id) || !hasText(memory.title)) {
    issues.push({
      code: institutional.role === "position" ? "invalid_position" : "invalid_procedure",
      id: institutional.id,
      message: "institutional memories require stable IDs and titles",
    })
  }
  if (
    !["global", "workspace", "project", "session"].includes(memory.scope.kind) ||
    (memory.scope.kind === "global" ? memory.scope.id !== undefined : !hasText(memory.scope.id))
  ) {
    issues.push({
      code: institutional.role === "position" ? "invalid_position" : "invalid_procedure",
      id: institutional.id,
      message: "institutional memories require a valid scope",
    })
  }
  validateApplicability(institutional, issues)
  validateReview(institutional, asOf, issues)
}

function validatePosition(
  memory: InstitutionalWrite,
  position: InstitutionalPosition,
  issues: InstitutionalValidationIssue[],
): void {
  if (memory.type !== "decision") {
    issues.push({
      code: "invalid_position",
      id: position.id,
      message: "positions must use the decision memory type",
    })
  }
  if (!hasText(position.owner) && !hasText(position.authority)) {
    issues.push({
      code: "missing_authority",
      id: position.id,
      message: "positions require an owner or authority",
    })
  }
  if (!nonEmptyStrings(position.sourceRefs)) {
    issues.push({
      code: "missing_source_ref",
      id: position.id,
      message: "positions require non-empty source references",
    })
  }
  if (!hasProvenance(memory)) {
    issues.push({
      code: "missing_provenance",
      id: position.id,
      message: "positions require attributable provenance",
    })
  }
  if (!nonEmptyStrings(position.boundaryConditions)) {
    issues.push({
      code: "invalid_position",
      id: position.id,
      message: "positions require non-empty boundary conditions",
    })
  }
}

function validateProcedure(
  memory: InstitutionalWrite,
  procedure: InstitutionalProcedure,
  issues: InstitutionalValidationIssue[],
): void {
  if (memory.type !== "procedure") {
    issues.push({
      code: "invalid_procedure",
      id: procedure.id,
      message: "procedures must use the procedure memory type",
    })
  }
  const stepIds = new Set<string>()
  const invalidSteps =
    !Array.isArray(procedure.steps) ||
    procedure.steps.some((step) => {
      if (!hasText(step.id) || !hasText(step.instruction) || stepIds.has(step.id)) return true
      stepIds.add(step.id)
      return false
    })
  if (!Array.isArray(procedure.steps) || procedure.steps.length === 0 || invalidSteps) {
    issues.push({
      code: "invalid_procedure",
      id: procedure.id,
      message: "procedures require uniquely identified ordered steps",
    })
  }
  if (
    !nonEmptyStrings(procedure.positionIds) ||
    !nonEmptyStrings(procedure.requiredEvidence) ||
    !nonEmptyStrings(procedure.completionCriteria) ||
    !nonEmptyStrings(procedure.escalationConditions)
  ) {
    issues.push({
      code: "invalid_procedure",
      id: procedure.id,
      message:
        "procedures require positions, evidence, completion criteria, and escalation conditions",
    })
  }
  if (memory.content !== procedureContent(procedure)) {
    issues.push({
      code: "invalid_procedure",
      id: procedure.id,
      message: "procedure content must be the ordered steps only, not copied position facts",
    })
  }
}

function validateEntry(
  memory: InstitutionalWrite,
  asOf: Date,
  issues: InstitutionalValidationIssue[],
): void {
  const institutional = memory.institutional
  if (!institutional) return
  validateSharedEntry(memory, institutional, asOf, issues)
  if (institutional.role === "position") {
    validatePosition(memory, institutional, issues)
    return
  }
  validateProcedure(memory, institutional, issues)
}

export function validateInstitutionalMemory(
  memory: MemoryWrite,
  options: InstitutionalValidationOptions = {},
): InstitutionalValidationResult {
  const issues: InstitutionalValidationIssue[] = []
  if (memory.institutional) validateEntry(memory, options.asOf ?? new Date(), issues)
  return { valid: issues.length === 0, issues }
}

function validateReferences(
  institutionals: InstitutionalMemory[],
  issues: InstitutionalValidationIssue[],
): void {
  const byId = new Map(institutionals.map((memory) => [memory.id, memory]))
  for (const memory of institutionals) {
    for (const reference of references(memory)) {
      const target = byId.get(reference)
      const expectedRole =
        memory.role === "position" || memory.positionIds?.includes(reference)
          ? "position"
          : "procedure"
      if (!target || target.role !== expectedRole) {
        issues.push({
          code: "missing_reference",
          id: memory.id,
          message: `institutional reference ${reference} must resolve to a ${expectedRole}`,
        })
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (memory: InstitutionalMemory): void => {
    if (visited.has(memory.id)) return
    if (visiting.has(memory.id)) {
      issues.push({
        code: "dependency_cycle",
        id: memory.id,
        message: "institutional dependencies form a cycle",
      })
      return
    }
    visiting.add(memory.id)
    for (const reference of references(memory)) {
      const target = byId.get(reference)
      if (target) visit(target)
    }
    visiting.delete(memory.id)
    visited.add(memory.id)
  }
  for (const memory of institutionals) visit(memory)
}

/**
 * Validates a curated collection before a provider persists or routes it.
 * Generic memories without `institutional` metadata are intentionally ignored.
 */
export function validateInstitutionalMemories(
  memories: InstitutionalWrite[],
  options: InstitutionalValidationOptions = {},
): InstitutionalValidationResult {
  const asOf = options.asOf ?? new Date()
  const issues: InstitutionalValidationIssue[] = []
  const seen = new Set<string>()
  const institutionals = memories.flatMap((memory) =>
    memory.institutional ? [memory.institutional] : [],
  )
  for (const memory of memories) {
    if (!memory.institutional) continue
    if (seen.has(memory.institutional.id)) {
      issues.push({
        code: "duplicate_id",
        id: memory.institutional.id,
        message: "institutional IDs must be unique across positions and procedures",
      })
    }
    seen.add(memory.institutional.id)
    validateEntry(memory, asOf, issues)
  }
  validateReferences(institutionals, issues)
  return { valid: issues.length === 0, issues }
}
