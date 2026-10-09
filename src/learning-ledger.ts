import type { CandidateMemory } from "./observation.js"
import type { MemoryProvider } from "./types.js"

/** Managed stores can execute a domain plan and its lineage decision atomically.
 * The supplied provider is transaction-bound and must not escape the callback.
 * An implementation may retry the callback after serialization conflicts. */
export interface AtomicCandidateStore {
  withCandidateTransaction(
    candidate: CandidateMemory,
    operation: (provider: MemoryProvider, candidate: CandidateMemory) => Promise<CandidateMemory>,
    signal?: AbortSignal,
  ): Promise<CandidateMemory>
}

export function isAtomicCandidateStore(value: unknown): value is AtomicCandidateStore {
  return (
    typeof value === "object" &&
    value !== null &&
    "withCandidateTransaction" in value &&
    typeof value.withCandidateTransaction === "function"
  )
}

export interface CandidateLineage {
  candidateId: string
  state: string
  memoryId?: string
  revision: number
  observationIds: string[]
  availableObservationIds: string[]
  audit: { revision: number; state: string; action: string; actor: string }[]
}
