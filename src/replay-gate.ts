import { randomUUID } from "node:crypto"
import type { OrchestratorConfig } from "./config.js"
import {
  applyMutationToInstitutionalSet,
  type CorrectionCandidate,
  type InstitutionalLoader,
  type ReplayGate,
  type ReplayGateResult,
} from "./correction.js"
import type { InstitutionalWrite } from "./institutional.js"
import { RememOrchestrator } from "./orchestrator.js"
import type {
  CatalogEntry,
  EmbeddingModel,
  MemoryCapabilities,
  MemoryContext,
  MemoryProvider,
  MemoryResult,
  MemorySearchRequest,
  ProviderDescriptor,
} from "./types.js"

/**
 * Read-only, in-memory `MemoryProvider` serving a fixed institutional
 * corpus. Used to run a candidate's mutation against the orchestrator
 * without touching any real provider.
 */
class OverlayMemoryProvider implements MemoryProvider {
  readonly id = "correction-replay-overlay"
  private readonly records: Array<{ id: string; write: InstitutionalWrite }>

  constructor(writes: InstitutionalWrite[]) {
    // A random id per record (rather than a shared counter) keeps every
    // OverlayMemoryProvider instance self-contained: two replay runs in the
    // same process never share or race over an id sequence.
    this.records = writes.map((write) => ({
      id: write.institutional?.id ?? randomUUID(),
      write,
    }))
  }

  capabilities(): MemoryCapabilities {
    return {
      lexicalSearch: true,
      semanticSearch: false,
      metadataFiltering: false,
      catalog: true,
      read: true,
      write: false,
      update: false,
      delete: false,
      episodicHistory: false,
      structuredEntities: false,
      filesystemDocuments: false,
    }
  }

  descriptor(): ProviderDescriptor {
    return {
      id: this.id,
      name: "Correction replay overlay",
      summary: "Ephemeral corpus used to replay a correction candidate's mutation.",
      categories: ["curated"],
      aliases: [],
      scopeKinds: ["global", "workspace", "project", "session"],
    }
  }

  catalog(context: MemoryContext): Promise<CatalogEntry[]> {
    return Promise.resolve(
      this.records
        .filter((record) => scopeMatches(record.write, context))
        .map(({ id, write }) => ({
          id,
          title: write.title,
          aliases: [],
          summary: write.content.slice(0, 200),
          providerIds: [this.id],
          scope: write.scope,
          tags: [],
          importance: 0.9,
          unresolved: false,
          ...(write.institutional ? { institutional: write.institutional } : {}),
        })),
    )
  }

  search(request: MemorySearchRequest): Promise<MemoryResult[]> {
    const topics = new Set(request.topics)
    return Promise.resolve(
      this.records
        .filter(
          (record) => scopeMatches(record.write, request.context) && topics.has(record.write.title),
        )
        .map(({ id, write }) => ({
          record: {
            providerId: this.id,
            id,
            title: write.title,
            content: write.content,
            source: `${this.id}:${id}`,
            scope: write.scope,
            type: write.type,
            freshness: "current" as const,
            ...(write.provenance ? { provenance: write.provenance } : {}),
            ...(write.institutional ? { institutional: write.institutional } : {}),
          },
          score: 0.9,
          reasons: ["correction replay overlay"],
        })),
    )
  }
}

function scopeMatches(write: InstitutionalWrite, context: MemoryContext): boolean {
  if (write.scope.kind === "global") return true
  if (write.scope.kind === "project") return write.scope.id === context.projectId
  if (write.scope.kind === "workspace") return write.scope.id === context.worktree
  return write.scope.id === context.sessionId
}

interface ReplayScenario {
  id: string
  prompt: string
  context: MemoryContext
  expectedOutcome: string
}

function scenarioFor(candidate: CorrectionCandidate): ReplayScenario {
  return {
    id: candidate.id,
    prompt: candidate.correction.prompt,
    context: candidate.correction.context,
    expectedOutcome: candidate.correction.expectedOutcome,
  }
}

/**
 * Replays a correction candidate's own scenario -- does asking the original
 * question now surface the corrected content? -- against an in-memory
 * overlay of the current institutional corpus with the candidate's mutation
 * applied, plus a regression check against every previously *applied*
 * candidate's own scenario, so this mutation can't silently break an
 * earlier fix. Neither check touches a real provider or persists anything;
 * the mutation is only ever exercised in this ephemeral overlay before a
 * human approves it for real.
 */
export class TargetedReplayGate implements ReplayGate {
  constructor(
    private readonly config: OrchestratorConfig,
    private readonly loadInstitutionalWrites: InstitutionalLoader<InstitutionalWrite[]>,
    private readonly listPriorApplied: () => Promise<CorrectionCandidate[]>,
    // Pass the same embedding model the production orchestrator uses.
    // Without this, semantic recognition during replay defaults to
    // LocalHashEmbeddingModel regardless of what's actually configured, so
    // a candidate could pass or fail this gate based on a different
    // retrieval algorithm than the one that will serve the real correction.
    private readonly embeddingModel?: EmbeddingModel,
    private readonly maxRegressionScenarios = 20,
  ) {}

  async run(candidate: CorrectionCandidate): Promise<ReplayGateResult> {
    if (!candidate.mutation) {
      return { passed: false, caseIds: [], failures: ["no mutation to replay"] }
    }
    const existing = await this.loadInstitutionalWrites(candidate.correction.context)
    const overlaid = applyMutationToInstitutionalSet(candidate.mutation, existing)
    const orchestrator = new RememOrchestrator(
      [new OverlayMemoryProvider(overlaid)],
      this.config,
      undefined,
      this.embeddingModel ? { embeddingModel: this.embeddingModel } : {},
    )

    const priorApplied = await this.listPriorApplied()
    const scenarios = [
      scenarioFor(candidate),
      ...priorApplied.slice(0, this.maxRegressionScenarios).map(scenarioFor),
    ]

    const failures: string[] = []
    for (const scenario of scenarios) {
      const injection = await orchestrator.processPrompt(scenario.prompt, scenario.context)
      if (!injection.text.includes(scenario.expectedOutcome)) {
        failures.push(
          `${scenario.id}: expected outcome not present in synthesized memory after applying the mutation`,
        )
      }
    }
    return {
      passed: failures.length === 0,
      caseIds: scenarios.map((scenario) => scenario.id),
      failures,
    }
  }
}
