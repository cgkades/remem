import type { MemoryTrace } from "./types.js"

export type TraceKind = "dispatch" | "search"

interface TraceEntry {
  trace: MemoryTrace
  kind: TraceKind
}

export class MemoryDiagnostics {
  private readonly bySession = new Map<string, TraceEntry[]>()

  constructor(
    private readonly maxSessions = 100,
    private readonly maxTracesPerSession = 20,
  ) {}

  record(trace: MemoryTrace, kind: TraceKind = "dispatch"): void {
    let entries = this.bySession.get(trace.sessionId)
    if (entries) {
      // Re-insert to move this session to most-recently-used for eviction.
      this.bySession.delete(trace.sessionId)
    } else {
      entries = []
    }
    this.bySession.set(trace.sessionId, entries)
    entries.push({ trace, kind })
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
   * as opposed to the dispatch trace for whatever message triggered the
   * turn currently in progress (which, when that message is itself the
   * correction, would otherwise be misidentified as the trace being
   * corrected -- the "context" hook always records a fresh dispatch trace
   * for the current turn before a tool call in that same turn can run).
   * Explicit `memory_search` calls are excluded from this count so an ad
   * hoc search between two turns doesn't shift which dispatch is "current"
   * vs "prior".
   */
  priorDispatch(sessionId: string): MemoryTrace | undefined {
    const dispatches = (this.bySession.get(sessionId) ?? []).filter(
      (entry) => entry.kind === "dispatch",
    )
    return dispatches.at(-2)?.trace
  }
}
