import { describe, expect, it } from "vitest"
import {
  COMPACTION_LEVELS,
  DEFAULT_HARD_LIMIT_BYTES,
  DEFAULT_SOFT_LIMIT_BYTES,
  ESCALATION_THRESHOLD_CONSECUTIVE_CHECKS,
  bulkArtifactTargetBytes,
  capacityStatus,
  compactionLevelAtIndex,
  compactionLevelIndex,
  decideEscalation,
  narrativeTargetBytes,
  shouldFireHardLimitWarning,
  type CapacityLimits,
  type EscalationState,
} from "../src/capacity.js"

const limits: CapacityLimits = {
  softLimitBytes: DEFAULT_SOFT_LIMIT_BYTES,
  hardLimitBytes: DEFAULT_HARD_LIMIT_BYTES,
}

describe("compaction level ordering", () => {
  it("orders levels from conservative (least aggressive) to maximum (most aggressive)", () => {
    expect(COMPACTION_LEVELS).toEqual(["conservative", "moderate", "aggressive", "maximum"])
  })

  it("bulk-artifact target bytes strictly decrease as the level escalates", () => {
    const targets = COMPACTION_LEVELS.map((level) => bulkArtifactTargetBytes(level))
    for (let i = 1; i < targets.length; i++) {
      expect(targets[i]).toBeLessThan(targets[i - 1]!)
    }
  })

  it("narrative text is left untouched (undefined target) at every level except maximum", () => {
    expect(narrativeTargetBytes("conservative")).toBeUndefined()
    expect(narrativeTargetBytes("moderate")).toBeUndefined()
    expect(narrativeTargetBytes("aggressive")).toBeUndefined()
    expect(narrativeTargetBytes("maximum")).toEqual(expect.any(Number))
  })

  it("compactionLevelIndex/compactionLevelAtIndex round-trip", () => {
    for (const level of COMPACTION_LEVELS) {
      expect(compactionLevelAtIndex(compactionLevelIndex(level))).toBe(level)
    }
  })

  it("compactionLevelAtIndex clamps out-of-range indices rather than throwing", () => {
    expect(compactionLevelAtIndex(-5)).toBe("conservative")
    expect(compactionLevelAtIndex(999)).toBe("maximum")
  })
})

describe("capacityStatus", () => {
  it("reports neither over-soft nor over-hard well under the soft limit", () => {
    const status = capacityStatus(1000, "conservative", limits)
    expect(status).toMatchObject({
      overSoft: false,
      overHard: false,
      compactionLevel: "conservative",
    })
  })

  it("reports over-soft but not over-hard between the two limits", () => {
    const status = capacityStatus(limits.softLimitBytes + 1, "conservative", limits)
    expect(status.overSoft).toBe(true)
    expect(status.overHard).toBe(false)
  })

  it("reports over-hard (and necessarily over-soft, since hard > soft) above the hard limit", () => {
    const status = capacityStatus(limits.hardLimitBytes + 1, "conservative", limits)
    expect(status.overSoft).toBe(true)
    expect(status.overHard).toBe(true)
  })

  it("is a boundary, not an off-by-one -- exactly at the limit is not yet 'over'", () => {
    expect(capacityStatus(limits.softLimitBytes, "conservative", limits).overSoft).toBe(false)
    expect(capacityStatus(limits.hardLimitBytes, "conservative", limits).overHard).toBe(false)
  })
})

describe("decideEscalation", () => {
  function state(overrides: Partial<EscalationState> = {}): EscalationState {
    return {
      level: "conservative",
      previousTotalBytes: undefined,
      consecutiveNoImprovement: 0,
      ...overrides,
    }
  }

  it("never escalates on the very first observed run (no previous baseline to compare against)", () => {
    const decision = decideEscalation(state(), 5_000_000)
    expect(decision).toEqual({
      level: "conservative",
      consecutiveNoImprovement: 0,
      escalated: false,
    })
  })

  it("does not escalate after a single non-improving run -- escalation responds to sustained pressure, not one reading", () => {
    const decision = decideEscalation(state({ previousTotalBytes: 1000 }), 1000)
    expect(decision.escalated).toBe(false)
    expect(decision.consecutiveNoImprovement).toBe(1)
  })

  it("resets the no-improvement counter as soon as a run shows genuine improvement", () => {
    const decision = decideEscalation(
      state({ previousTotalBytes: 1000, consecutiveNoImprovement: 2 }),
      900,
    )
    expect(decision.escalated).toBe(false)
    expect(decision.consecutiveNoImprovement).toBe(0)
    expect(decision.level).toBe("conservative")
  })

  it(`escalates exactly once the no-improvement streak reaches ${ESCALATION_THRESHOLD_CONSECUTIVE_CHECKS} consecutive runs`, () => {
    let current = state({ previousTotalBytes: 1000 })
    for (let i = 0; i < ESCALATION_THRESHOLD_CONSECUTIVE_CHECKS - 1; i++) {
      const decision = decideEscalation(current, 1000)
      expect(decision.escalated).toBe(false)
      current = {
        level: decision.level,
        previousTotalBytes: 1000,
        consecutiveNoImprovement: decision.consecutiveNoImprovement,
      }
    }
    const finalDecision = decideEscalation(current, 1000)
    expect(finalDecision.escalated).toBe(true)
    expect(finalDecision.level).toBe("moderate")
    expect(finalDecision.consecutiveNoImprovement).toBe(0)
  })

  it("never escalates past 'maximum'", () => {
    const decision = decideEscalation(
      state({
        level: "maximum",
        previousTotalBytes: 1000,
        consecutiveNoImprovement: ESCALATION_THRESHOLD_CONSECUTIVE_CHECKS,
      }),
      1000,
    )
    expect(decision.level).toBe("maximum")
    expect(decision.escalated).toBe(false)
  })

  it("never de-escalates -- an improving run at a higher level stays at that level, it does not drop back down", () => {
    const decision = decideEscalation(state({ level: "aggressive", previousTotalBytes: 1000 }), 500)
    expect(decision.level).toBe("aggressive")
    expect(decision.escalated).toBe(false)
  })

  it("a worsening (growing) total also counts as non-improvement, not just a flat total", () => {
    const decision = decideEscalation(state({ previousTotalBytes: 1000 }), 1_500)
    expect(decision.consecutiveNoImprovement).toBe(1)
  })
})

describe("shouldFireHardLimitWarning", () => {
  const now = new Date("2026-09-16T12:00:00.000Z")
  const hardLimitBytes = 1000

  it("never fires when at or under the hard limit, regardless of throttle state", () => {
    expect(shouldFireHardLimitWarning(1000, hardLimitBytes, undefined, now)).toBe(false)
    expect(shouldFireHardLimitWarning(500, hardLimitBytes, undefined, now)).toBe(false)
  })

  it("fires the first time a scope crosses the hard limit (never warned before)", () => {
    expect(shouldFireHardLimitWarning(1001, hardLimitBytes, undefined, now)).toBe(true)
  })

  it("does not fire again within the throttle window after a recent warning", () => {
    const lastWarnedAt = new Date(now.getTime() - 60 * 60 * 1000) // 1 hour ago
    expect(
      shouldFireHardLimitWarning(1001, hardLimitBytes, lastWarnedAt, now, 24 * 60 * 60 * 1000),
    ).toBe(false)
  })

  it("fires again once the throttle window has fully elapsed", () => {
    const lastWarnedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000) // 25 hours ago
    expect(
      shouldFireHardLimitWarning(1001, hardLimitBytes, lastWarnedAt, now, 24 * 60 * 60 * 1000),
    ).toBe(true)
  })

  it("is a boundary, not an off-by-one -- exactly at the throttle interval fires", () => {
    const lastWarnedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    expect(
      shouldFireHardLimitWarning(1001, hardLimitBytes, lastWarnedAt, now, 24 * 60 * 60 * 1000),
    ).toBe(true)
  })
})
