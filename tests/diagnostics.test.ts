import { describe, expect, it } from "vitest"
import { MemoryDiagnostics } from "../src/diagnostics.js"
import type { MemoryTrace } from "../src/types.js"

function trace(sessionId: string, prompt: string): MemoryTrace {
  return {
    sessionId,
    prompt,
    timestamp: new Date().toISOString(),
    catalogEntries: 0,
    catalogMatches: [],
    shouldRetrieve: false,
    confidence: 0,
    topics: [],
    signals: [],
    providers: [],
    rawResults: 0,
    deduplicatedResults: 0,
    selectedResults: 0,
    catalogTokens: 0,
    recallTokens: 0,
    totalDurationMs: 0,
    diagnostics: [],
  }
}

describe("MemoryDiagnostics", () => {
  it("latest() returns undefined before any trace is recorded", () => {
    const diagnostics = new MemoryDiagnostics()
    expect(diagnostics.latest("session-1")).toBeUndefined()
    expect(diagnostics.latest()).toBeUndefined()
  })

  it("latest() returns the most recently recorded trace for a session", () => {
    const diagnostics = new MemoryDiagnostics()
    const a = trace("session-1", "first")
    const b = trace("session-1", "second")
    diagnostics.record(a)
    diagnostics.record(b)
    expect(diagnostics.latest("session-1")).toBe(b)
  })

  it("latest() without a session id falls back to the most recent trace across all sessions", () => {
    const diagnostics = new MemoryDiagnostics()
    diagnostics.record(trace("session-1", "first"))
    const b = trace("session-2", "second")
    diagnostics.record(b)
    expect(diagnostics.latest()).toBe(b)
  })

  it("priorDispatch() returns undefined until a second dispatch trace has been recorded", () => {
    const diagnostics = new MemoryDiagnostics()
    expect(diagnostics.priorDispatch("session-1")).toBeUndefined()
    diagnostics.record(trace("session-1", "first"))
    expect(diagnostics.priorDispatch("session-1")).toBeUndefined()
  })

  it("priorDispatch() returns the dispatch trace before the current one", () => {
    const diagnostics = new MemoryDiagnostics()
    const a = trace("session-1", "first")
    const b = trace("session-1", "second")
    diagnostics.record(a)
    diagnostics.record(b)
    expect(diagnostics.priorDispatch("session-1")).toBe(a)
    expect(diagnostics.latest("session-1")).toBe(b)
  })

  it("priorDispatch() ignores search-kind traces entirely", () => {
    const diagnostics = new MemoryDiagnostics()
    const a = trace("session-1", "first dispatch")
    const search = trace("session-1", "explicit search")
    const b = trace("session-1", "second dispatch")
    diagnostics.record(a)
    diagnostics.record(search, "search")
    diagnostics.record(b)
    expect(diagnostics.priorDispatch("session-1")).toBe(a)
    // The overall latest trace is still whatever was recorded last, search
    // traces included.
    expect(diagnostics.latest("session-1")).toBe(b)
  })

  it("does not mix dispatch history across sessions", () => {
    const diagnostics = new MemoryDiagnostics()
    diagnostics.record(trace("session-1", "s1-first"))
    diagnostics.record(trace("session-1", "s1-second"))
    diagnostics.record(trace("session-2", "s2-first"))
    expect(diagnostics.priorDispatch("session-2")).toBeUndefined()
  })

  it("evicts the oldest trace per session beyond the configured cap", () => {
    const diagnostics = new MemoryDiagnostics(100, 2)
    const a = trace("session-1", "first")
    const b = trace("session-1", "second")
    const c = trace("session-1", "third")
    diagnostics.record(a)
    diagnostics.record(b)
    diagnostics.record(c)
    expect(diagnostics.priorDispatch("session-1")).toBe(b)
    expect(diagnostics.latest("session-1")).toBe(c)
  })

  it("priorDispatch() coalesces repeated dispatches within the same turnId, not just the same kind", () => {
    const diagnostics = new MemoryDiagnostics()
    const turn1 = trace("session-1", "original question")
    const turn2First = trace("session-1", "correction message")
    const turn2ToolLoop = trace("session-1", "correction message")
    diagnostics.record(turn1, "dispatch", "1")
    // A tool-calling loop re-dispatches to the model (and re-runs the
    // "context" hook) multiple times within the same turn; all of these
    // share the turn's id and must not be mistaken for an earlier turn.
    diagnostics.record(turn2First, "dispatch", "2")
    diagnostics.record(turn2ToolLoop, "dispatch", "2")
    const prior = diagnostics.priorDispatch("session-1")
    expect(prior).toBe(turn1)
    expect(prior).not.toBe(turn2First)
    expect(prior).not.toBe(turn2ToolLoop)
  })

  it("priorDispatch() falls back to the immediately preceding dispatch when no turnId is supplied", () => {
    const diagnostics = new MemoryDiagnostics()
    const a = trace("session-1", "first")
    const b = trace("session-1", "second")
    diagnostics.record(a)
    diagnostics.record(b)
    expect(diagnostics.priorDispatch("session-1")).toBe(a)
  })

  it("priorDispatch() ignores a search trace even between two same-turnId dispatches", () => {
    const diagnostics = new MemoryDiagnostics()
    const turn1 = trace("session-1", "original question")
    const search = trace("session-1", "explicit search")
    const turn2 = trace("session-1", "correction message")
    diagnostics.record(turn1, "dispatch", "1")
    diagnostics.record(search, "search")
    diagnostics.record(turn2, "dispatch", "2")
    diagnostics.record(trace("session-1", "correction message (tool loop)"), "dispatch", "2")
    expect(diagnostics.priorDispatch("session-1")).toBe(turn1)
  })

  it("evicts the oldest session beyond the configured session cap", () => {
    const diagnostics = new MemoryDiagnostics(1, 20)
    diagnostics.record(trace("session-1", "first"))
    diagnostics.record(trace("session-2", "second"))
    expect(diagnostics.latest("session-1")).toBeUndefined()
    expect(diagnostics.latest("session-2")).toBeDefined()
  })
})
