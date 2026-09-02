import type { MemoryTrace } from "./types.js"

export class MemoryDiagnostics {
  private readonly traces = new Map<string, MemoryTrace>()

  constructor(private readonly maxSessions = 100) {}

  record(trace: MemoryTrace): void {
    this.traces.delete(trace.sessionId)
    this.traces.set(trace.sessionId, trace)
    while (this.traces.size > this.maxSessions) {
      const oldest = this.traces.keys().next().value
      if (!oldest) break
      this.traces.delete(oldest)
    }
  }

  latest(sessionId?: string): MemoryTrace | undefined {
    if (sessionId) return this.traces.get(sessionId)
    return [...this.traces.values()].at(-1)
  }
}
