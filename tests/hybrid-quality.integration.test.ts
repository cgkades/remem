import { readFile, mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Pool } from "pg"
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { RememOrchestrator } from "../src/orchestrator.js"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import { runMigrations } from "../src/storage/migrations.js"
import type { MemoryWrite, MemoryContext } from "../src/types.js"
import { testConfig } from "./helpers.js"

interface FixtureEntry {
  id: string
  title: string
  aliases: string[]
  summary: string
  tags: string[]
  type: MemoryWrite["type"]
  freshness: NonNullable<MemoryWrite["freshness"]>
  content: string
  unresolved?: boolean
}
interface QualityCase {
  id: string
  partition: string
  prompt: string
  expected: string | null
}
interface ScoreRow {
  id: string
  lexical_score: number | string
  semantic_score: number | string
}
const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
const integration = databaseUrl ? describe.sequential : describe.skip

function reciprocalRanks(rows: ScoreRow[]): string[] {
  const lexical = rows
    .filter((row) => Number(row.lexical_score) > 0)
    .sort((a, b) => Number(b.lexical_score) - Number(a.lexical_score))
  const semantic = rows
    .filter((row) => Number(row.semantic_score) >= 0.34)
    .sort((a, b) => Number(b.semantic_score) - Number(a.semantic_score))
  const scores = new Map<string, number>()
  for (const ranking of [lexical, semantic])
    ranking.forEach((row, index) => {
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (60 + index + 1))
    })
  return [...rows]
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .map((row) => row.id)
}
function rankMetrics(ranking: string[], expected?: string) {
  const rank = expected ? ranking.indexOf(expected) : -1
  return {
    recallAt5: rank >= 0 && rank < 5 ? 1 : 0,
    precisionAt5: rank >= 0 && rank < 5 ? 1 / Math.max(1, Math.min(5, ranking.length)) : 0,
    reciprocalRank: rank >= 0 ? 1 / (rank + 1) : 0,
  }
}
function p95(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0
}

integration("PostgreSQL hybrid retrieval quality", () => {
  const pool = new Pool({ connectionString: databaseUrl })
  const embeddingModel = new LocalHashEmbeddingModel()
  const provider = new PostgresMemoryProvider(
    {
      type: "postgres",
      id: "quality-provider",
      connectionString: databaseUrl ?? "",
      primary: true,
      maxConnections: 2,
      catalogLimit: 100,
    },
    { pool, embeddingModel },
  )
  const context: MemoryContext = {
    directory: "/workspace/quality",
    worktree: "/workspace/quality",
    projectId: "quality-project",
    sessionId: "fresh-quality-session",
  }
  const config = testConfig({
    budgets: { catalogTokens: 1400, recallTokens: 900, perProviderTokens: 700 },
    maxResults: 5,
  })
  let fixture: { entries: FixtureEntry[]; cases: QualityCase[] }
  const ids = new Map<string, string>()
  const forbidden = new Set<string>()
  const orchestrator = new RememOrchestrator([provider], config)

  beforeAll(async () => {
    await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
    await runMigrations(pool)
    fixture = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./fixtures/evaluation/hybrid-quality.json", import.meta.url)),
        "utf8",
      ),
    ) as typeof fixture
    for (const item of fixture.entries) {
      const foreign = ["coffee", "vacation", "mercury-kafka", "project-phoenixville"].includes(
        item.id,
      )
      const scope: MemoryWrite["scope"] =
        item.id === "global-concise"
          ? { kind: "global" }
          : item.id === "session-private"
            ? { kind: "session", id: "old-session" }
            : { kind: "project", id: foreign ? "foreign-project" : context.projectId }
      const record = await provider.write({
        title: item.title + " [" + item.id + "]",
        content: item.content,
        summary: item.summary,
        aliases: item.aliases,
        tags: item.tags,
        type: item.type,
        freshness: item.freshness,
        scope,
        unresolved: item.unresolved ?? false,
        provenance: [
          {
            source: { kind: "document", uri: "fixture://" + item.id },
            capturedAt: "2026-09-01T00:00:00.000Z",
            original: true,
          },
        ],
      })
      ids.set(item.id, record.id)
      if (foreign || item.id === "session-private" || item.freshness === "superseded")
        forbidden.add(record.id)
    }
  })
  afterAll(async () => {
    await pool.end()
  })

  it("measures actual hybrid candidates, offline RRF and injection without exposing fixture bodies in the report", async () => {
    const cases = []
    const durations = []
    for (const item of fixture.cases) {
      const spy = vi.spyOn(pool, "query")
      const started = performance.now()
      let candidates
      let calls: Array<[unknown, unknown]>
      try {
        candidates = await provider.search({
          query: item.prompt,
          topics: [],
          context,
          limit: 5,
          maxTokens: 700,
          reason: "quality fixture",
          signal: new AbortController().signal,
        })
        durations.push(performance.now() - started)
        calls = spy.mock.calls as unknown as Array<[unknown, unknown]>
      } finally {
        spy.mockRestore()
      }
      const captured = calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("lexical_candidates"),
      )
      if (!captured || typeof captured[0] !== "string" || !Array.isArray(captured[1]))
        throw new Error("missing actual candidate query")
      const expanded = captured[0].replace(/LIMIT \$7\s*$/u, "LIMIT 1000")
      if (expanded === captured[0])
        throw new Error("candidate query changed; benchmark needs review")
      const rows = (await pool.query<ScoreRow>(expanded, captured[1] as unknown[])).rows
      for (const row of rows) expect(forbidden.has(row.id)).toBe(false)
      const expected = item.expected ? ids.get(item.expected) : undefined
      const actual = candidates.map((value) => value.record.id)
      const fused = reciprocalRanks(rows)
      // Suppressing only the new topic arm reproduces the pre-PR provider
      // behavior through the same planner/recall/synthesis pipeline.
      const originalSearch = provider.search.bind(provider)
      const baselineSearch = vi
        .spyOn(provider, "search")
        .mockImplementation((request) => originalSearch({ ...request, topics: [] }))
      let baselineInjection
      try {
        baselineInjection = await new RememOrchestrator([provider], config).processPrompt(
          item.prompt,
          context,
        )
      } finally {
        baselineSearch.mockRestore()
      }
      const injection = await orchestrator.processPrompt(item.prompt, context)
      const plannedCandidates = await provider.search({
        query: item.prompt,
        topics: injection.plan.topics,
        context,
        limit: 5,
        maxTokens: 700,
        reason: "planned topic comparison",
        signal: new AbortController().signal,
      })
      for (const bad of fixture.entries.filter((value) => forbidden.has(ids.get(value.id) ?? ""))) {
        expect(injection.memoryText).not.toContain(bad.content)
      }
      cases.push({
        id: item.id,
        partition: item.partition,
        relevant: !!expected,
        baselineInjectedRelevant:
          !!item.expected &&
          baselineInjection.memoryText.includes(
            fixture.entries.find((value) => value.id === item.expected)!.content,
          ),
        baselineUnrelatedInjected: !item.expected && baselineInjection.trace.selectedResults > 0,
        baselineEstimatedTokens:
          baselineInjection.trace.catalogTokens + baselineInjection.trace.recallTokens,
        baselineDispatchMs: baselineInjection.trace.totalDurationMs,
        hybrid: rankMetrics(actual, expected),
        topicAware: rankMetrics(
          plannedCandidates.map((value) => value.record.id),
          expected,
        ),
        rrf: rankMetrics(fused, expected),
        injectedRelevant:
          !!item.expected &&
          injection.memoryText.includes(
            fixture.entries.find((value) => value.id === item.expected)!.content,
          ),
        unrelatedInjected: !item.expected && injection.trace.selectedResults > 0,
        nonTargetSelected: fixture.entries.filter(
          (value) =>
            value.id !== item.expected &&
            injection.memoryText.includes("Source: " + provider.id + ":" + ids.get(value.id) + " "),
        ).length,
        selectedCount: injection.trace.selectedResults,
        estimatedTokens: injection.trace.catalogTokens + injection.trace.recallTokens,
        dispatchMs: injection.trace.totalDurationMs,
        rankingReasons: candidates.map((value) => ({
          label: [...ids].find(([, id]) => id === value.record.id)?.[0],
          score: value.score,
          reasons: value.reasons,
        })),
      })
    }
    const relevant = cases.filter((value) => value.relevant)
    const unrelated = cases.filter((value) => !value.relevant)
    const mean = (values: number[]) =>
      values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)
    const metrics = {
      embedding: "deterministic local hash; not a neural quality claim",
      relevantCases: relevant.length,
      unrelatedCases: unrelated.length,
      hybridRecallAt5: mean(relevant.map((value) => value.hybrid.recallAt5)),
      hybridPrecisionAt5: mean(relevant.map((value) => value.hybrid.precisionAt5)),
      hybridMRR: mean(relevant.map((value) => value.hybrid.reciprocalRank)),
      topicAwareRecallAt5: mean(relevant.map((value) => value.topicAware.recallAt5)),
      topicAwareMRR: mean(relevant.map((value) => value.topicAware.reciprocalRank)),
      offlineRrfRecallAt5: mean(relevant.map((value) => value.rrf.recallAt5)),
      offlineRrfPrecisionAt5: mean(relevant.map((value) => value.rrf.precisionAt5)),
      offlineRrfMRR: mean(relevant.map((value) => value.rrf.reciprocalRank)),
      relevantInjectionRate: mean(relevant.map((value) => (value.injectedRelevant ? 1 : 0))),
      baselineRelevantInjectionRate: mean(
        relevant.map((value) => (value.baselineInjectedRelevant ? 1 : 0)),
      ),
      baselineFalseInjectionRate: mean(
        unrelated.map((value) => (value.baselineUnrelatedInjected ? 1 : 0)),
      ),
      baselineEstimatedTokenMax: Math.max(...cases.map((value) => value.baselineEstimatedTokens)),
      baselineDispatchP95Ms: p95(cases.map((value) => value.baselineDispatchMs)),
      falseInjectionRate: mean(unrelated.map((value) => (value.unrelatedInjected ? 1 : 0))),
      forbiddenCandidates: 0,
      nonTargetSelected: cases.reduce((sum, value) => sum + value.nonTargetSelected, 0),
      estimatedTokenMax: Math.max(...cases.map((value) => value.estimatedTokens)),
      candidateP95Ms: p95(durations),
      dispatchP95Ms: p95(cases.map((value) => value.dispatchMs)),
    }
    const output = path.join(process.cwd(), "artifacts", "hybrid-retrieval-quality.json")
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify({ metrics, cases }, null, 2) + "\n")
    process.stdout.write("hybrid-quality " + JSON.stringify(metrics) + "\n")
    for (const item of cases)
      process.stdout.write(
        "hybrid-quality-case " + JSON.stringify({ ...item, rankingReasons: undefined }) + "\n",
      )
    expect(metrics.hybridRecallAt5).toBeGreaterThanOrEqual(0.8)
    expect(metrics.relevantInjectionRate).toBeGreaterThanOrEqual(
      metrics.baselineRelevantInjectionRate,
    )
    expect(metrics.topicAwareRecallAt5).toBeGreaterThan(metrics.hybridRecallAt5)
    expect(metrics.relevantInjectionRate).toBeGreaterThanOrEqual(0.8)
    expect(metrics.falseInjectionRate).toBe(0)
    expect(metrics.estimatedTokenMax).toBeLessThanOrEqual(2300)
    expect(metrics.candidateP95Ms).toBeLessThan(config.providerTimeoutMs)
  })

  it("recovers an alias-recognized topic when full-prompt lexical/vector recall misses it", async () => {
    const injection = await orchestrator.processPrompt(
      "Resume the Phoenix streaming cutover.",
      context,
    )
    expect(injection.plan.requests.flatMap((request) => request.topics ?? [])).toContain(
      "Project Phoenix Kafka migration [phoenix-kafka]",
    )
    expect(injection.memoryText).toContain(
      "Use dual writes, compare offsets, then cut consumers over.",
    )
    const recalled = await provider.search({
      query: "Resume the Phoenix streaming cutover.",
      topics: ["Project Phoenix Kafka migration [phoenix-kafka]"],
      context,
      limit: 5,
      maxTokens: 700,
      reason: "recognized alias",
      signal: new AbortController().signal,
    })
    const baseline = await provider.search({
      query: "Resume the Phoenix streaming cutover.",
      topics: [],
      context,
      limit: 5,
      maxTokens: 700,
      reason: "pre-change topic behavior",
      signal: new AbortController().signal,
    })
    expect(baseline.map((value) => value.record.id)).not.toContain(ids.get("phoenix-kafka"))
    expect(recalled[0]?.record.id).toBe(ids.get("phoenix-kafka"))
    expect(recalled[0]?.reasons).toContain("PostgreSQL catalog topic match")
    expect(recalled[0]?.reasons).not.toContain("PostgreSQL full-text match")
  })

  it("cannot use planned topics to bypass scope or supersession", async () => {
    const titles = fixture.entries
      .filter((value) => forbidden.has(ids.get(value.id) ?? ""))
      .map((value) => value.title + " [" + value.id + "]")
    const results = await provider.search({
      query: "absentmarker",
      topics: titles,
      context,
      limit: 10,
      maxTokens: 700,
      reason: "forged topics",
      signal: new AbortController().signal,
    })
    expect(results.every((value) => !forbidden.has(value.record.id))).toBe(true)
  })

  it("keeps lexical exact-identifier recall during embedding failure", async () => {
    const embed = vi
      .spyOn(embeddingModel, "embed")
      .mockRejectedValue(new Error("embedding unavailable"))
    try {
      const results = await provider.search({
        query: "bedrock-auth",
        topics: [],
        context,
        limit: 5,
        maxTokens: 700,
        reason: "fallback fixture",
        signal: new AbortController().signal,
      })
      expect(results.map((value) => value.record.id)).toContain(ids.get("bedrock-auth"))
      expect(results[0]?.reasons).toContain("PostgreSQL full-text match")
    } finally {
      embed.mockRestore()
    }
  })

  it("fails open on provider outage and rejects cancellation without exposing error bodies", async () => {
    const search = vi.spyOn(provider, "search").mockRejectedValue(new Error("unsafe failure body"))
    try {
      const injection = await orchestrator.processPrompt(
        "Continue the Phoenix streaming cutover.",
        context,
      )
      expect(injection.memoryText).toBe("")
      expect(injection.trace.providers[0]?.status).toBe("failed")
      expect(injection.text).not.toContain("unsafe failure body")
    } finally {
      search.mockRestore()
    }
    const abort = new AbortController()
    abort.abort()
    await expect(
      provider.search({
        query: "bedrock-auth",
        topics: [],
        context,
        limit: 5,
        maxTokens: 700,
        reason: "cancel fixture",
        signal: abort.signal,
      }),
    ).rejects.toThrow()
  })
})
