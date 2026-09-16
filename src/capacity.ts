/**
 * TASK-012/TASK-060 (Phase 3, approved 2026-09-16): the approved two-tier
 * soft/hard capacity policy -- no age-based deletion of any kind. Retention
 * is governed entirely by size pressure, in two tiers per provider/project:
 *
 *   - Soft limit (default 1 GiB logical bytes): 60+-day-old eligible
 *     entries become candidates for compaction (shrinking, never
 *     deleting): heavy reduction of bulk artifacts, minimal reduction of
 *     reasoning/narrative text. Compaction starts conservative and its
 *     aggressiveness is an explicit, escalating level the system may raise
 *     on its own only if the soft-to-hard gap keeps closing despite the
 *     current level running -- never a silent escalation, always visible
 *     via the current level being a plain readable value (`doctor`/
 *     `status` surfacing is a caller's responsibility; this module exposes
 *     the level, it does not print it). A forced full compaction ignores
 *     the 60-day gate on demand.
 *   - Hard limit (default 2 GiB logical bytes): only past this does
 *     anything get *removed*, oldest-eligible-first, and only after
 *     compaction has already run. Explicit privacy deletion (TASK-013's
 *     forget path) always overrides both tiers immediately regardless of
 *     age -- this module implements no privacy-driven deletion at all.
 *
 * This module holds the pure, storage-independent policy logic (limits,
 * ordered aggressiveness levels, per-level reduction targets, and the
 * escalation decision). Storage-layer application (querying/updating
 * `remem.session_events`/`remem.capacity_state`) lives in
 * `providers/postgres.ts`'s `PostgresMemoryProvider` methods, which call
 * into this module rather than duplicating the policy.
 */

export const BYTES_PER_GIB = 1024 ** 3

/** Default soft limit: 1 GiB logical bytes per provider/project. Configurable per project (see `CapacityLimits`). */
export const DEFAULT_SOFT_LIMIT_BYTES = 1 * BYTES_PER_GIB

/** Default hard limit: 2 GiB logical bytes per provider/project. Configurable per project (see `CapacityLimits`). */
export const DEFAULT_HARD_LIMIT_BYTES = 2 * BYTES_PER_GIB

/** An entry becomes compaction-eligible (and, only past the hard limit, removal-eligible) once it is at least this many days old. A forced full compaction (`force: true`) ignores this gate entirely. */
export const COMPACTION_ELIGIBILITY_DAYS = 60

/**
 * Ordered, explicit compaction-aggressiveness levels -- index order *is*
 * the escalation order (index 0 is the conservative starting point; a
 * later index is strictly more aggressive). Never reordered/renamed
 * without updating every stored `compaction_level`/`compacted_at_level`
 * value's meaning.
 */
export const COMPACTION_LEVELS = ["conservative", "moderate", "aggressive", "maximum"] as const
export type CompactionLevel = (typeof COMPACTION_LEVELS)[number]

/**
 * How many bytes a classified bulk artifact (see `bulk-artifact-reduction.ts`)
 * is reduced to at each level -- strictly decreasing (more aggressive) as
 * the level escalates. "Heavy reduction of bulk-artifact content" (the
 * plan's own words) is realized here as a shrinking output-byte target,
 * reusing the same deterministic head/tail/key-line extraction TASK-059
 * already established, not a second divergent algorithm.
 *
 * Known, deliberate scope note: every one of these per-level targets is
 * below `BULK_ARTIFACT_MIN_BYTES` (2000, `bulk-artifact-reduction.ts`) --
 * the floor a payload must already be at or above to be classified as a
 * bulk artifact at all. TASK-059 already reduces any bulk artifact to at
 * most `BULK_ARTIFACT_MAX_OUTPUT_BYTES` (2000, often far less in practice)
 * *at admission time*, before it ever reaches storage. Consequence: for
 * content that went through the normal `admitEvidence` pipeline, this
 * compaction path only has further work to do in the narrow case where
 * the admission-time reduction landed close to its own 2000-byte ceiling.
 * In practice this path matters most for content that bypassed TASK-059's
 * reduction entirely (e.g. legacy pre-TASK-010 rows, or a future admission
 * path that doesn't route through `admitEvidence`) -- it is not, today, a
 * routinely-exercised branch of the steady-state admission pipeline. This
 * is a real, disclosed scope characteristic, not a bug: TASK-059 already
 * does the "heavy reduction" job for freshly admitted content; TASK-060's
 * version of the same logic exists for whatever reaches storage without
 * having gone through it.
 */
const BULK_ARTIFACT_TARGET_BYTES_BY_LEVEL: Record<CompactionLevel, number> = {
  conservative: 1500,
  moderate: 800,
  aggressive: 400,
  maximum: 150,
}

/**
 * "Minimal reduction of reasoning/narrative text" (the plan's own words):
 * narrative/non-bulk-artifact text is left completely untouched at every
 * level except `maximum`, where it is only lightly bounded -- a
 * conservative ceiling, not a shrink-to-nothing pass. `undefined` means
 * "do not touch narrative text at this level at all."
 */
const NARRATIVE_TARGET_BYTES_BY_LEVEL: Record<CompactionLevel, number | undefined> = {
  conservative: undefined,
  moderate: undefined,
  aggressive: undefined,
  maximum: 4000,
}

export function bulkArtifactTargetBytes(level: CompactionLevel): number {
  return BULK_ARTIFACT_TARGET_BYTES_BY_LEVEL[level]
}

export function narrativeTargetBytes(level: CompactionLevel): number | undefined {
  return NARRATIVE_TARGET_BYTES_BY_LEVEL[level]
}

export function compactionLevelIndex(level: CompactionLevel): number {
  return COMPACTION_LEVELS.indexOf(level)
}

export function compactionLevelAtIndex(index: number): CompactionLevel {
  const clamped = Math.max(0, Math.min(index, COMPACTION_LEVELS.length - 1))
  return COMPACTION_LEVELS[clamped]!
}

export interface CapacityLimits {
  softLimitBytes: number
  hardLimitBytes: number
}

export const DEFAULT_CAPACITY_LIMITS: CapacityLimits = {
  softLimitBytes: DEFAULT_SOFT_LIMIT_BYTES,
  hardLimitBytes: DEFAULT_HARD_LIMIT_BYTES,
}

export interface CapacityStatus {
  totalBytes: number
  limits: CapacityLimits
  overSoft: boolean
  overHard: boolean
  compactionLevel: CompactionLevel
}

export function capacityStatus(
  totalBytes: number,
  level: CompactionLevel,
  limits: CapacityLimits,
): CapacityStatus {
  return {
    totalBytes,
    limits,
    overSoft: totalBytes > limits.softLimitBytes,
    overHard: totalBytes > limits.hardLimitBytes,
    compactionLevel: level,
  }
}

/**
 * How many consecutive compaction runs (at the current level, while still
 * over the soft limit) must show the total-bytes gap failing to shrink
 * before the level escalates. This is what makes escalation a response to
 * *sustained* pressure, per the plan, rather than a single noisy reading
 * (e.g. one run outpaced briefly by a concurrent write) triggering an
 * immediate, surprising jump in aggressiveness.
 */
export const ESCALATION_THRESHOLD_CONSECUTIVE_CHECKS = 3

export interface EscalationState {
  level: CompactionLevel
  /** Total bytes recorded the last time compaction ran at `level`, or `undefined` if this is the first run ever observed for this provider/project. */
  previousTotalBytes: number | undefined
  consecutiveNoImprovement: number
}

export interface EscalationDecision {
  level: CompactionLevel
  consecutiveNoImprovement: number
  escalated: boolean
}

/**
 * Pure decision function: given the state carried over from the last
 * compaction run and the total bytes observed *after* this run's
 * compaction actually executed, decides whether to escalate to the next
 * level. "Improvement" means the post-compaction total shrank relative to
 * the previous run's post-compaction total -- if the gap has not
 * meaningfully closed for `ESCALATION_THRESHOLD_CONSECUTIVE_CHECKS`
 * consecutive runs, and a more aggressive level exists, escalate one
 * level and reset the counter. Never escalates past `"maximum"`, and
 * never de-escalates (a level, once reached, is never silently lowered --
 * that would itself be a silent behavior change).
 */
export function decideEscalation(
  state: EscalationState,
  totalBytesAfterThisRun: number,
): EscalationDecision {
  const improved =
    state.previousTotalBytes === undefined || totalBytesAfterThisRun < state.previousTotalBytes
  const consecutiveNoImprovement = improved ? 0 : state.consecutiveNoImprovement + 1

  const currentIndex = compactionLevelIndex(state.level)
  const canEscalate = currentIndex < COMPACTION_LEVELS.length - 1
  const shouldEscalate =
    !improved && consecutiveNoImprovement >= ESCALATION_THRESHOLD_CONSECUTIVE_CHECKS && canEscalate

  if (shouldEscalate) {
    return {
      level: compactionLevelAtIndex(currentIndex + 1),
      consecutiveNoImprovement: 0,
      escalated: true,
    }
  }
  return { level: state.level, consecutiveNoImprovement, escalated: false }
}

/**
 * TASK-062: session-start hard-limit capacity warning.
 *
 * ** PROVISIONAL DEFAULT -- not yet maintainer-confirmed. ** The plan's own
 * task description explicitly says: "resolve the exact per-session-vs-
 * throttled cadence with the maintainer before shipping a default." This
 * value (and the "session-start gate AND a throttle interval, combined"
 * design in `shouldFireHardLimitWarning` below) is a conservative,
 * disclosed placeholder chosen so the feature is implementable and
 * testable now, not a final maintainer-approved decision. Revisit before
 * this ships as a real default; see `PROGRESS`/PR notes for this task.
 */
export const DEFAULT_HARD_LIMIT_WARNING_THROTTLE_MS = 24 * 60 * 60 * 1000

export interface HardLimitWarning {
  totalBytes: number
  hardLimitBytes: number
}

/**
 * Pure decision: given the current total, the hard limit, and when this
 * scope was last warned (`undefined` if never), decides whether to fire
 * the warning now. Never fires for the soft limit -- callers only ever
 * invoke this after already establishing `overHard`, and this function
 * itself only ever compares `totalBytes` against `hardLimitBytes` (never
 * the soft limit), so there is no code path here that could fire on soft-
 * limit pressure alone.
 *
 * This is the reference specification for the decision, exhaustively unit
 * tested in isolation -- it is *not* what `PostgresMemoryProvider.
 * checkHardLimitWarning` actually calls for the throttle-elapsed portion
 * of this decision. That implementation instead evaluates the elapsed-
 * time comparison inside a single SQL statement using Postgres's own
 * `now()` throughout, specifically to avoid mixing a Node process clock
 * (what calling this function with `new Date()` would do) with a
 * Postgres-server-stored timestamp, which would make the throttle
 * boundary sensitive to clock skew between the two. A future non-
 * PostgreSQL `CapacityStore` implementation without an equivalent atomic-
 * SQL option may reasonably call this function directly instead.
 */
export function shouldFireHardLimitWarning(
  totalBytes: number,
  hardLimitBytes: number,
  lastWarnedAt: Date | undefined,
  now: Date,
  throttleMs: number = DEFAULT_HARD_LIMIT_WARNING_THROTTLE_MS,
): boolean {
  // Strictly greater than, not "at or over" despite the plan's own plain-
  // English task description saying "at or near the hard limit" -- this
  // matches the established meaning of "over the hard limit" already used
  // by `capacityStatus`'s `overHard`/`enforceHardLimit`/`enforceCapacity`
  // throughout this codebase (all use the identical strict `>`), so a
  // project sitting exactly at its configured limit is treated the same
  // way by every capacity-related decision, not specially by this one.
  if (totalBytes <= hardLimitBytes) return false
  if (lastWarnedAt === undefined) return true
  return now.getTime() - lastWarnedAt.getTime() >= throttleMs
}
