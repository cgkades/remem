import type { MemoryContext, MemoryWrite } from "./types.js"

export type SessionEventKind =
  | "user-correction"
  | "decision"
  | "preference"
  | "incident-resolved"
  | "fact-discovered"
  | "task-opened"
  | "task-resolved"
  | "project-state"

export interface SessionObservation {
  id: string
  kind: SessionEventKind
  context: MemoryContext
  occurredAt: string
  source: string
  payload: Record<string, unknown>
}

export interface CandidateMemory {
  id: string
  observationIds: string[]
  memory: MemoryWrite
  confidence: number
  status: "pending" | "approved" | "rejected" | "promoted" | "expired"
  reasons: string[]
}

export interface CandidateExtractor {
  extract(observations: SessionObservation[], signal?: AbortSignal): Promise<CandidateMemory[]>
}

export interface CandidateValidator {
  validate(candidate: CandidateMemory, signal?: AbortSignal): Promise<CandidateMemory | undefined>
}

export interface ConsolidationPipeline {
  consolidate(candidates: CandidateMemory[], signal?: AbortSignal): Promise<CandidateMemory[]>
}
