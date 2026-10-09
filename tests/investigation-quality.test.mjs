import { describe, expect, it } from "vitest"
import {
  fixtureAnswer,
  measureInvestigation,
  memoryContext,
  percentile95,
} from "./investigation-quality.mjs"

const ref = `hooks-postgres:${"a".repeat(64)}`
const context = `<memory-context>
- [current; semantic; rank 1] Root
  Phoenix check uses file; root cause: the absent checkpoint.txt file failed its presence check.
  Evidence: ${ref}
- [current; procedure; rank 1] Procedure
  Goal: Recovery Command: test -f checkpoint.txt Command: printf 'ready' > checkpoint.txt Steps: same check subsequently completed with exit 0
  Evidence: ${ref}
- [current; decision; rank 1] Decision
  We decided to use isolated checkpoint directories for Phoenix.
- [current; task; rank 1] Follow-up
  Phoenix crash recovery is blocked on interruption tests.
- [unknown; episodic; rank 0.3] Historical read result; not a verified conclusion
  lookup root: workspace cwd
</memory-context>`
const expected = {
  rootCause: "the absent checkpoint.txt file failed its presence check",
  procedure: [
    "test -f checkpoint.txt",
    "printf 'ready' > checkpoint.txt",
    "test -f checkpoint.txt",
  ],
  decision: "We decided to use isolated checkpoint directories for Phoenix.",
  followUp: "Phoenix crash recovery is blocked on interruption tests.",
  detail: "lookup root: workspace cwd",
  detailAnswer: "workspace cwd",
}
const measure = (text = context, answer = fixtureAnswer(text)) =>
  measureInvestigation({
    context: text,
    answer,
    expected,
    forbidden: ["corrupted cache", "fixture-secret"],
    requiredRefs: [ref],
    latencyMs: 5,
  })

describe("investigation quality gate measures the dispatched evidence", () => {
  it("recovers only current supported fields, commands, uncertainty and provenance", () => {
    expect(measure()).toMatchObject({
      recallAtK: 1,
      answerCorrect: true,
      procedureAccuracy: true,
      provenanceCorrect: true,
      falseInjection: 0,
      unsupportedAssertions: 0,
    })
  })
  it("fails when memory is absent; expected answers are not fabricated", () => {
    expect(measure("")).toMatchObject({
      recallAtK: 0,
      answerCorrect: false,
      procedureAccuracy: false,
      provenanceCorrect: false,
    })
  })
  it("refuses a superseded conclusion as the current root cause", () => {
    const text = context.replace("current; semantic", "superseded; semantic")
    expect(fixtureAnswer(text).rootCause).toBeNull()
    expect(measure(text).answerCorrect).toBe(false)
  })
  it("detects incorrect answers even when recall succeeds", () => {
    expect(
      measure(context, { ...fixtureAnswer(context), rootCause: "corrupted cache" }),
    ).toMatchObject({ recallAtK: 1, answerCorrect: false, unsupportedAssertions: 1 })
  })
  it("detects forbidden injections and missing provenance", () => {
    expect(measure(`${context}\nfixture-secret`)).toMatchObject({ falseInjection: 1 })
    expect(measure(context.replaceAll(ref, "unavailable")).provenanceCorrect).toBe(false)
  })
  it("rejects a truncated procedure and requires its verification step", () => {
    expect(
      measure(context.replace("same check subsequently completed with exit 0", "truncated"))
        .procedureAccuracy,
    ).toBe(false)
  })
  it("separates context from the original transcript and uses conservative byte budgets", () => {
    const text = memoryContext([
      { content: "original transcript" },
      { content: [{ text: context }] },
    ])
    expect(text).toBe(context)
    expect(
      memoryContext([
        {
          content: `<memory-catalog>Unrelated global recognition hint</memory-catalog>\n${context}`,
        },
      ]),
    ).toBe(context)
    expect(measure(text).contextTokenUpperBound).toBeGreaterThan(0)
  })
  it("reports p95 of actual samples without mutating the measurements", () => {
    const samples = [5, 1, 3, 2, 4]
    expect(percentile95(samples)).toBe(5)
    expect(samples).toEqual([5, 1, 3, 2, 4])
    expect(() => percentile95([])).toThrow()
  })
})
