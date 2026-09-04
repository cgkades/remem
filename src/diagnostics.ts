import type { MemoryTrace } from "./types.js"

export type TraceKind = "dispatch" | "search"

interface TraceEntry {
  trace: MemoryTrace
  kind: TraceKind
  turnId: string | undefined
}

export class MemoryDiagnostics {
  private readonly bySession = new Map<string, TraceEntry[]>()

  constructor(
    private readonly maxSessions = 100,
    private readonly maxTracesPerSession = 20,
  ) {}

  /**
   * `turnId` identifies the user turn a dispatch trace belongs to (e.g. the
   * OpenCode v2 host derives it from how many user messages have been seen
   * in the conversation so far), so repeated dispatches within one turn --
   * a tool-calling loop re-dispatches to the model, and each round re-runs
   * the "context" hook -- can be told apart from a genuinely new turn. Kept
   * separate from `MemoryTrace` itself: it is host/diagnostics bookkeeping,
   * not part of a trace's own content.
   */
  record(trace: MemoryTrace, kind: TraceKind = "dispatch", turnId?: string): void {
    let entries = this.bySession.get(trace.sessionId)
    if (entries) {
      // Re-insert to move this session to most-recently-used for eviction.
      this.bySession.delete(trace.sessionId)
    } else {
      entries = []
    }
    this.bySession.set(trace.sessionId, entries)
    entries.push({ trace, kind, turnId })
    while (entries.length > this.maxTracesPerSession) entries.shift()
    while (this.bySession.size > this.maxSessions) {
      const oldest = this.bySession.keys().next().value
      if (!oldest) break
      this.bySession.delete(oldest)
    }
  }

  latest(sessionId?: string): MemoryTrace | undefined {
    if (sessionId) return this.bySession.get(sessionId)?.at(-1)?.trace
    return [...this.bySession.values()].at(-1)?.at(-1)?.trace
  }

  /**
   * The dispatch trace for the turn before the current one -- i.e. the
   * retrieval decision behind the response a correction is actually about,
   * as opposed to the dispatch trace for whatever triggered the turn
   * currently in progress (which, when that message is itself the
   * correction, would otherwise be misidentified as the trace being
   * corrected). Explicit `memory_search` calls are always excluded, so an
   * ad hoc search between two turns doesn't shift which dispatch is
   * "current" vs "prior".
   *
   * When dispatches carry a `turnId`, every dispatch sharing the latest
   * dispatch's `turnId` is treated as part of the turn in progress and
   * skipped too -- a tool-calling loop re-dispatches to the model multiple
   * times per turn (each round re-runs the "context" hook), and those
   * re-dispatches must not be mistaken for a separate, earlier turn just
   * because they are chronologically before the very latest one. Without a
   * `turnId` (a host that doesn't supply one), this falls back to simply
   * the dispatch immediately before the latest one.
   */
  priorDispatch(sessionId: string): MemoryTrace | undefined {
    const dispatches = (this.bySession.get(sessionId) ?? []).filter(
      (entry) => entry.kind === "dispatch",
    )
    const current = dispatches.at(-1)
    if (!current) return undefined
    if (current.turnId === undefined) return dispatches.at(-2)?.trace
    for (let index = dispatches.length - 2; index >= 0; index--) {
      const entry = dispatches[index]
      if (entry && entry.turnId !== current.turnId) return entry.trace
    }
    return undefined
  }
}
