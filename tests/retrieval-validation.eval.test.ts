import { readFile, mkdir, writeFile } from "node:fs/promises"
import { Pool } from "pg"
import { describe, expect, it, vi } from "vitest"
import { PostgresMemoryProvider } from "../src/providers/postgres.js"
import { RememOrchestrator } from "../src/orchestrator.js"
import { DeterministicRetrievalPlanner } from "../src/planner.js"
import { DeterministicRetrievalPlanner as BaselinePlanner } from "./fixtures/evaluation/baseline-planner.js"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import { createEmbeddingModel } from "../src/storage/embedding-neural.js"
import { runMigrations } from "../src/storage/migrations.js"
import { testConfig } from "./helpers.js"
import type { EmbeddingModel, MemoryFreshness } from "../src/types.js"
interface Fixture {
  entries: Array<{
    id: string
    title: string
    alias: string
    content: string
    freshness?: MemoryFreshness
    foreign?: boolean
  }>
  cases: Array<{ id: string; prompt: string; expected: string[] }>
}
const integration = process.env.REMEM_TEST_DATABASE_URL ? describe : describe.skip
integration("fresh real-PostgreSQL retrieval validation", () => {
  it("compares persisted baseline and current automatic selection on hash and real neural vectors at 5k rows", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/evaluation/retrieval-validation.json", import.meta.url),
        "utf8",
      ),
    ) as Fixture
    const pool = new Pool({ connectionString: process.env.REMEM_TEST_DATABASE_URL })
    const neural = await createEmbeddingModel({ backend: "neural" })
    expect(neural.id, "required real neural benchmark may not silently use fallback").toBe(
      "bge-small-en-v1.5",
    )
    const models: EmbeddingModel[] = [new LocalHashEmbeddingModel(), neural]
    const reports = []
    const context = {
      directory: "/validation",
      worktree: "/validation",
      projectId: "validation",
      sessionId: "fresh",
    }
    const config = testConfig({
      budgets: { catalogTokens: 1400, recallTokens: 1400, perProviderTokens: 1300 },
      maxResults: 5,
    })
    const percentile = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0
    try {
      for (const model of models) {
        await pool.query("DROP SCHEMA IF EXISTS remem CASCADE")
        await runMigrations(pool)
        const provider = new PostgresMemoryProvider(
          {
            type: "postgres",
            id: "validation",
            primary: true,
            connectionString: process.env.REMEM_TEST_DATABASE_URL!,
            maxConnections: 2,
            catalogLimit: 100,
          },
          { pool, embeddingModel: model },
        )
        const ids = new Map<string, string>()
        for (const item of fixture.entries) {
          const record = await provider.write({
            title: item.title,
            aliases: [item.alias],
            content: item.content,
            summary: item.content,
            scope: { kind: "project", id: item.foreign ? "foreign" : "validation" },
            type: "decision",
            freshness: item.freshness ?? "current",
          })
          ids.set(item.id, record.id)
        }
        // Ordinary retained documents and vectors, not 5k copies of target topics.
        await pool.query(`INSERT INTO remem.memories(id,provider_id,title,content,summary,scope_kind,scope_id,type,freshness)
          SELECT gen_random_uuid(),'validation','Archive note ' || g,'Unrelated archived inventory record ' || g,'Archived inventory','project','validation','semantic','current' FROM generate_series(1,5000) g`)
        const filler = await model.embed("Archived inventory record")
        await pool.query(
          `INSERT INTO remem.memory_embeddings(memory_id,model,dimensions,embedding)
          SELECT id,$1,384,$2::vector FROM remem.memories WHERE title LIKE 'Archive note %'`,
          [model.id, `[${filler.join(",")}]`],
        )
        await pool.query("ANALYZE remem.memories; ANALYZE remem.memory_embeddings")
        const rows = []
        const baselinePlanner = new BaselinePlanner(config.planner)
        for (const item of fixture.cases) {
          const originalSearch = provider.search.bind(provider)
          const plannerSpy = vi
            .spyOn(DeterministicRetrievalPlanner.prototype, "plan")
            .mockImplementation((...args) => baselinePlanner.plan(...args))
          const searchSpy = vi
            .spyOn(provider, "search")
            .mockImplementation((request) => originalSearch({ ...request, catalogOnly: false }))
          let baseline
          try {
            baseline = await new RememOrchestrator([provider], config, undefined, {
              embeddingModel: model,
            }).processPrompt(item.prompt, context)
          } finally {
            plannerSpy.mockRestore()
            searchSpy.mockRestore()
          }
          const current = await new RememOrchestrator([provider], config, undefined, {
            embeddingModel: model,
          }).processPrompt(item.prompt, context)
          const selected = (text: string) =>
            [...text.matchAll(/Source: validation:([a-f0-9-]+) /gu)].map(
              (match) => [...ids].find(([, id]) => id === match[1])?.[0] ?? "background",
            )
          const before = selected(baseline.memoryText)
          const after = selected(current.memoryText)
          const expected = item.expected
          const metric = (found: string[]) => ({
            recall: expected.length
              ? expected.filter((id) => found.includes(id)).length / expected.length
              : 0,
            precision: found.length
              ? found.filter((id) => expected.includes(id)).length / found.length
              : 0,
            falseInjection: expected.length === 0 && found.length > 0,
            nonTarget: found.filter((id) => !expected.includes(id)).length,
          })
          const durations = []
          const baselineDurations = []
          let beforeCandidates: string[] = []
          let afterCandidates: string[] = []
          const labels = (results: Awaited<ReturnType<typeof originalSearch>>) =>
            results.map(
              (result) => [...ids].find(([, id]) => id === result.record.id)?.[0] ?? "background",
            )
          for (let repeat = 0; repeat < 10; repeat++) {
            const beforeStart = performance.now()
            beforeCandidates = labels(
              await originalSearch({
                query: item.prompt,
                topics: baseline.plan.topics,
                catalogOnly: false,
                context,
                limit: 5,
                maxTokens: 1300,
                reason: "baseline latency",
                signal: new AbortController().signal,
              }),
            )
            baselineDurations.push(performance.now() - beforeStart)
            const start = performance.now()
            afterCandidates = labels(
              await originalSearch({
                query: item.prompt,
                topics: current.plan.topics,
                catalogOnly: current.plan.matches.some(
                  (match) => current.plan.topics.includes(match.entry.title) && match.score >= 0.9,
                ),
                context,
                limit: 5,
                maxTokens: 1300,
                reason: "latency benchmark",
                signal: new AbortController().signal,
              }),
            )
            durations.push(performance.now() - start)
          }
          expect(after).not.toContain("foreign")
          expect(after).not.toContain("old")
          expect(current.memoryText).not.toContain("Archive note")
          for (const id of before.filter((id) => expected.includes(id)))
            expect(after, `preserve baseline ${model.id}/${item.id}`).toContain(id)
          rows.push({
            id: item.id,
            expected,
            baseline: metric(before),
            current: metric(after),
            baselineIds: before,
            currentIds: after,
            baselineCandidateP95Ms: percentile(baselineDurations),
            candidateP95Ms: percentile(durations),
            candidateBaseline: {
              ...metric(beforeCandidates),
              mrr: expected.length
                ? Math.max(
                    0,
                    ...expected.map((id) =>
                      beforeCandidates.includes(id) ? 1 / (beforeCandidates.indexOf(id) + 1) : 0,
                    ),
                  )
                : 0,
            },
            candidateCurrent: {
              ...metric(afterCandidates),
              mrr: expected.length
                ? Math.max(
                    0,
                    ...expected.map((id) =>
                      afterCandidates.includes(id) ? 1 / (afterCandidates.indexOf(id) + 1) : 0,
                    ),
                  )
                : 0,
            },
            baselineTokens: baseline.trace.catalogTokens + baseline.trace.recallTokens,
            currentTokens: current.trace.catalogTokens + current.trace.recallTokens,
            dispatchMs: current.trace.totalDurationMs,
          })
        }
        reports.push({
          model: model.id,
          corpusRows: 5010,
          cases: rows,
          baselineCandidateP95Ms: percentile(rows.map((row) => row.baselineCandidateP95Ms)),
          candidateP95Ms: percentile(rows.map((row) => row.candidateP95Ms)),
          dispatchP95Ms: percentile(rows.map((row) => row.dispatchMs)),
        })
      }
      await mkdir("artifacts", { recursive: true })
      await writeFile(
        "artifacts/retrieval-validation.json",
        JSON.stringify(
          { baselineCommit: "0dc565310475964c7c2ac030dda4a31b4c7ee664", reports },
          null,
          2,
        ) + "\n",
      )
      for (const report of reports) {
        process.stdout.write("retrieval-validation " + JSON.stringify(report) + "\n")
        expect(report.cases.filter((row) => row.current.falseInjection)).toHaveLength(0)
        for (const row of report.cases.filter((row) => row.expected.length > 0)) {
          expect(row.current.recall, `${report.model}/${row.id} relevant recall`).toBe(1)
          expect(row.current.precision, `${report.model}/${row.id} recall excerpt precision`).toBe(
            1,
          )
        }
        expect(
          report.cases.reduce((sum, row) => sum + row.current.nonTarget, 0),
        ).toBeLessThanOrEqual(report.cases.reduce((sum, row) => sum + row.baseline.nonTarget, 0))
        expect(report.candidateP95Ms).toBeLessThan(config.providerTimeoutMs)
      }
    } finally {
      await pool.end()
    }
  }, 240_000)
})
