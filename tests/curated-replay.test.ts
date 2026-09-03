import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { RememOrchestrator } from "../src/orchestrator.js"
import { SemanticCatalogRecognizer } from "../src/planning/semantic.js"
import type {
  CatalogEntry,
  EmbeddingModel,
  InstitutionalMemory,
  MemoryContext,
  MemoryFreshness,
  MemoryInjection,
  MemoryProvider,
  MemorySearchRequest,
  MemoryTrace,
  MemoryType,
} from "../src/types.js"
import { testConfig } from "./helpers.js"

type ReplayOutcome = "answer" | "no-answer" | "escalation"

interface ReplayRecord {
  id: string
  caseIds: string[]
  title: string
  aliases: string[]
  summary: string
  tags: string[]
  type: MemoryType
  freshness: MemoryFreshness
  content: string
  embedding?: number[]
  institutional?: InstitutionalMemory
}

interface ReplayExpectation {
  outcome: ReplayOutcome
  route: {
    shouldRetrieve: boolean
    providerIds: string[]
    applicability: Array<{ id: string; applicable: boolean }>
    semanticAttempted?: boolean
  }
  positionIds: string[]
  procedureIds: string[]
  citations: string[]
  evidence: string[]
  forbiddenConclusions: string[]
  escalation?: string
  tokenLimit: number
  latencyLimitMs: number
  providerFailures: number
  freshness?: string[]
}

interface ReplayCase {
  id: string
  prompt: string
  context?: Partial<MemoryContext>
  providerFailure?: boolean
  expected: ReplayExpectation
}

interface ReplayFixture {
  version: 1
  name: string
  records: ReplayRecord[]
  cases: ReplayCase[]
}

interface ReplayJudge {
  judge(input: { rubric: string; prompt: string; memoryText: string }): Promise<string>
}

interface ReplayCheck {
  name: string
  passed: boolean
  expected: unknown
  actual: unknown
}

interface ReplayCaseResult {
  id: string
  passed: boolean
  checks: ReplayCheck[]
  outcome: ReplayOutcome
  selectedPositionIds: string[]
  selectedProcedureIds: string[]
  citations: string[]
  trace: MemoryTrace
  judge?: { rubric: string; input: string; output?: string; error?: string }
}

interface ReplayResults {
  fixture: string
  version: number
  passed: boolean
  cases: ReplayCaseResult[]
}

class ReplayProvider implements MemoryProvider {
  readonly id = "curated-replay"

  constructor(
    private readonly records: ReplayRecord[],
    private readonly failSearch: boolean,
  ) {}

  capabilities() {
    return {
      lexicalSearch: true,
      semanticSearch: true,
      metadataFiltering: true,
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

  descriptor() {
    return {
      id: this.id,
      name: "Curated replay memory",
      summary: "Deterministic replay fixture provider.",
      categories: ["curated"],
      aliases: ["replay"],
      scopeKinds: ["project" as const],
      embedding: [0],
    }
  }

  catalog(context: MemoryContext, _signal: AbortSignal): Promise<CatalogEntry[]> {
    return Promise.resolve(
      this.records
        .filter((record) => record.caseIds.includes(context.sessionId ?? ""))
        .map((record) => catalogEntry(record, context)),
    )
  }

  search(request: MemorySearchRequest) {
    if (this.failSearch) return Promise.reject(new Error("replay provider unavailable"))
    const topics = new Set(request.topics)
    return Promise.resolve(
      this.records
        .filter((record) => record.caseIds.includes(request.context.sessionId ?? ""))
        .filter((record) => topics.has(record.title))
        .map((record) => ({
          record: {
            providerId: this.id,
            id: record.id,
            title: record.title,
            content: record.content,
            summary: record.summary,
            source: `replay://${record.id}`,
            scope: { kind: "project" as const, id: request.context.projectId },
            type: record.type,
            freshness: record.freshness,
            ...(record.institutional ? { institutional: record.institutional } : {}),
          },
          score: 0.9,
          reasons: ["replay fixture"],
        })),
    )
  }
}

const semanticProbe: EmbeddingModel = {
  id: "curated-replay-semantic-probe",
  dimensions: 1,
  embed: () => Promise.resolve([1]),
}

function catalogEntry(record: ReplayRecord, context: MemoryContext): CatalogEntry {
  return {
    id: record.id,
    title: record.title,
    aliases: record.aliases,
    summary: record.summary,
    providerIds: ["curated-replay"],
    scope: { kind: "project", id: context.projectId },
    tags: record.tags,
    importance: 0.9,
    unresolved: false,
    ...(record.embedding ? { embedding: record.embedding } : {}),
    ...(record.institutional ? { institutional: record.institutional } : {}),
  }
}

function check(checks: ReplayCheck[], name: string, expected: unknown, actual: unknown): void {
  checks.push({
    name,
    passed: JSON.stringify(expected) === JSON.stringify(actual),
    expected,
    actual,
  })
}

function includes(checks: ReplayCheck[], name: string, expected: string, value: string): void {
  checks.push({ name, passed: value.includes(expected), expected, actual: value })
}

function selectedIds(
  records: ReplayRecord[],
  injection: MemoryInjection,
  role: InstitutionalMemory["role"],
): string[] {
  return records
    .filter(
      (record) =>
        record.institutional?.role === role &&
        injection.memoryText.includes(`Source: curated-replay:${record.id}`),
    )
    .map((record) => record.institutional?.id)
    .filter((id): id is string => id !== undefined)
    .sort()
}

function expectedOutcome(caseExpectation: ReplayExpectation, injection: MemoryInjection): boolean {
  if (caseExpectation.outcome === "answer") return injection.trace.selectedResults > 0
  if (caseExpectation.outcome === "no-answer") return injection.trace.selectedResults === 0
  return Boolean(
    caseExpectation.escalation && injection.memoryText.includes(caseExpectation.escalation),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function validateFixture(fixture: ReplayFixture): void {
  if (fixture.version !== 1) throw new Error("unsupported replay fixture version")
  if (!Array.isArray(fixture.records) || !Array.isArray(fixture.cases)) {
    throw new Error("replay fixture requires records and cases arrays")
  }
  for (const record of fixture.records) {
    if (
      !isRecord(record) ||
      typeof record.id !== "string" ||
      typeof record.title !== "string" ||
      typeof record.summary !== "string" ||
      typeof record.content !== "string" ||
      !isStringArray(record.caseIds) ||
      !isStringArray(record.aliases) ||
      !isStringArray(record.tags)
    ) {
      throw new Error("replay record has an invalid shape")
    }
  }
  const ids = new Set<string>()
  for (const replayCase of fixture.cases) {
    if (
      !isRecord(replayCase) ||
      typeof replayCase.id !== "string" ||
      typeof replayCase.prompt !== "string"
    ) {
      throw new Error("replay case has an invalid shape")
    }
    const expected = replayCase.expected
    if (
      !isRecord(expected) ||
      !isRecord(expected.route) ||
      typeof expected.route.shouldRetrieve !== "boolean" ||
      !isStringArray(expected.route.providerIds) ||
      !Array.isArray(expected.route.applicability) ||
      !expected.route.applicability.every(
        (item) =>
          isRecord(item) && typeof item.id === "string" && typeof item.applicable === "boolean",
      ) ||
      !isStringArray(expected.positionIds) ||
      !isStringArray(expected.procedureIds) ||
      !isStringArray(expected.citations) ||
      !isStringArray(expected.evidence) ||
      !isStringArray(expected.forbiddenConclusions) ||
      !Number.isFinite(expected.tokenLimit) ||
      !Number.isFinite(expected.latencyLimitMs) ||
      !Number.isFinite(expected.providerFailures)
    ) {
      throw new Error("replay case has an invalid shape")
    }
    if (ids.has(replayCase.id)) throw new Error(`duplicate replay case ${replayCase.id}`)
    ids.add(replayCase.id)
    if (!["answer", "no-answer", "escalation"].includes(expected.outcome)) {
      throw new Error(`${replayCase.id} has no deterministic outcome`)
    }
  }
}

async function runReplayFixture(
  fixture: ReplayFixture,
  judge?: ReplayJudge,
): Promise<ReplayResults> {
  validateFixture(fixture)
  const cases: ReplayCaseResult[] = []
  for (const replayCase of fixture.cases) {
    const context: MemoryContext = {
      directory: "/workspace/replay",
      worktree: "/workspace/replay",
      projectId: "phoenix",
      sessionId: replayCase.id,
      ...replayCase.context,
    }
    const injection = await new RememOrchestrator(
      [new ReplayProvider(fixture.records, replayCase.providerFailure === true)],
      testConfig({ budgets: { catalogTokens: 600, recallTokens: 1_000, perProviderTokens: 900 } }),
      undefined,
      { embeddingModel: semanticProbe },
    ).processPrompt(replayCase.prompt, context)
    const checks: ReplayCheck[] = []
    const expected = replayCase.expected
    const selectedPositionIds = selectedIds(fixture.records, injection, "position")
    const selectedProcedureIds = selectedIds(fixture.records, injection, "procedure")
    const providerIds = injection.plan.requests.map((request) => request.providerId).sort()
    const applicability = (injection.trace.applicability ?? [])
      .map(({ institutionalId, applicable }) => ({ id: institutionalId, applicable }))
      .sort((left, right) => left.id.localeCompare(right.id))
    const expectedApplicability = expected.route.applicability
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id))
    const citations = fixture.records
      .filter((record) => injection.memoryText.includes(`(replay://${record.id})`))
      .map((record) => `replay://${record.id}`)

    check(
      checks,
      "route should retrieve",
      expected.route.shouldRetrieve,
      injection.plan.shouldRetrieve,
    )
    check(checks, "route providers", expected.route.providerIds.slice().sort(), providerIds)
    check(checks, "applicability", expectedApplicability, applicability)
    if (expected.route.semanticAttempted !== undefined) {
      check(
        checks,
        "semantic attempt",
        expected.route.semanticAttempted,
        injection.trace.semanticAttempted,
      )
    }
    check(checks, "selected positions", expected.positionIds.slice().sort(), selectedPositionIds)
    check(checks, "selected procedures", expected.procedureIds.slice().sort(), selectedProcedureIds)
    check(checks, "outcome", true, expectedOutcome(expected, injection))
    for (const citation of expected.citations) {
      check(checks, `citation ${citation}`, true, citations.includes(citation))
    }
    for (const evidence of expected.evidence)
      includes(checks, `evidence ${evidence}`, evidence, injection.memoryText)
    for (const freshness of expected.freshness ?? []) {
      includes(checks, `freshness ${freshness}`, freshness, injection.memoryText)
    }
    for (const conclusion of expected.forbiddenConclusions) {
      check(
        checks,
        `forbidden conclusion ${conclusion}`,
        false,
        injection.memoryText.includes(conclusion),
      )
    }
    check(
      checks,
      "token limit",
      true,
      injection.trace.catalogTokens + injection.trace.recallTokens <= expected.tokenLimit,
    )
    check(checks, "latency limit", true, injection.trace.totalDurationMs <= expected.latencyLimitMs)
    check(
      checks,
      "provider failures",
      expected.providerFailures,
      injection.trace.providers.filter((provider) => provider.status !== "ok").length,
    )

    const rubric = [
      `Expected outcome: ${expected.outcome}.`,
      `Required citations: ${expected.citations.join(", ") || "none"}.`,
      `Required evidence: ${expected.evidence.join(", ") || "none"}.`,
      `Forbidden conclusions: ${expected.forbiddenConclusions.join(", ") || "none"}.`,
    ].join("\n")
    let judgeRecord: ReplayCaseResult["judge"]
    if (judge) {
      const input = JSON.stringify({ prompt: replayCase.prompt, memoryText: injection.memoryText })
      try {
        judgeRecord = {
          rubric,
          input,
          output: await judge.judge({
            rubric,
            prompt: replayCase.prompt,
            memoryText: injection.memoryText,
          }),
        }
      } catch (error) {
        judgeRecord = {
          rubric,
          input,
          error: error instanceof Error ? error.message : "unknown judge failure",
        }
      }
    }
    cases.push({
      id: replayCase.id,
      passed: checks.every((item) => item.passed),
      checks,
      outcome: expected.outcome,
      selectedPositionIds,
      selectedProcedureIds,
      citations,
      trace: injection.trace,
      ...(judgeRecord ? { judge: judgeRecord } : {}),
    })
  }
  return {
    fixture: fixture.name,
    version: fixture.version,
    passed: cases.every((item) => item.passed),
    cases,
  }
}

async function writeReplayResults(results: ReplayResults, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(results, null, 2)}\n`)
  await rename(temporary, file)
}

describe("curated guidance behavioral replay", () => {
  it("runs versioned scenarios through production retrieval and injection", async () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/replay/curated-guidance.v1.json", import.meta.url),
    )
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ReplayFixture
    const results = await runReplayFixture(fixture)
    const outputPath = process.env.REMEM_REPLAY_RESULTS_PATH
    if (outputPath) await writeReplayResults(results, outputPath)

    expect(results.passed).toBe(true)
    expect(results.cases).toHaveLength(7)
    expect(results.cases.find((item) => item.id === "inapplicable-semantic-gate")).toMatchObject({
      passed: true,
      selectedPositionIds: [],
      trace: { semanticAttempted: true, shouldRetrieve: true },
    })
    const blocked = fixture.records.find(({ id }) => id === "wrong-project-position")
    if (!blocked) throw new Error("missing semantic gate fixture")
    const recognition = await new SemanticCatalogRecognizer(semanticProbe).recognize(
      fixture.cases.find(({ id }) => id === "inapplicable-semantic-gate")?.prompt ?? "",
      [catalogEntry(blocked, { directory: "/", worktree: "/", projectId: "phoenix" })],
      [],
    )
    expect(recognition.matches[0]?.score).toBe(1)
  })

  it("records an optional rubric-driven judge without making it a regression gate", async () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/replay/curated-guidance.v1.json", import.meta.url),
    )
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ReplayFixture
    const results = await runReplayFixture(fixture, {
      judge: ({ rubric, prompt }) =>
        Promise.resolve(`advisory review for ${prompt}: ${rubric.length}`),
    })

    expect(results.passed).toBe(true)
    expect(results.cases[0]?.judge?.rubric).toContain("Expected outcome")
    expect(results.cases[0]?.judge?.input).toContain("memoryText")
    expect(results.cases[0]?.judge?.output).toContain("advisory review")
  })

  it("captures judge failures without changing deterministic replay status", async () => {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/replay/curated-guidance.v1.json", import.meta.url),
    )
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ReplayFixture
    const results = await runReplayFixture(fixture, {
      judge: () => Promise.reject(new Error("judge unavailable")),
    })

    expect(results.passed).toBe(true)
    expect(results.cases[0]?.judge?.error).toBe("judge unavailable")
  })
})
