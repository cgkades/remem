import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { DeterministicConsolidationPipeline } from "../src/consolidation.js"
import type { CandidateMemory } from "../src/observation.js"
import type { MemoryProvider, MemoryRecord, MemoryWrite } from "../src/types.js"

class InMemoryProvider implements MemoryProvider {
  readonly id = "test-memory"
  readonly records = new Map<string, MemoryRecord>()

  capabilities() {
    return {
      lexicalSearch: true,
      semanticSearch: false,
      metadataFiltering: false,
      catalog: false,
      read: true,
      write: true,
      update: true,
      delete: true,
      episodicHistory: true,
      structuredEntities: true,
      filesystemDocuments: false,
    }
  }

  catalog() {
    return Promise.resolve([])
  }

  search() {
    return Promise.resolve(
      [...this.records.values()].map((record) => ({ record, score: 1, reasons: [] })),
    )
  }

  write(memory: MemoryWrite): Promise<MemoryRecord> {
    const id = memory.id ?? randomUUID()
    const record: MemoryRecord = {
      providerId: this.id,
      id,
      title: memory.title,
      content: memory.content,
      source: memory.source ?? `memory://${id}`,
      scope: memory.scope,
      type: memory.type,
      freshness: memory.freshness ?? "current",
      ...(memory.observedAt ? { observedAt: memory.observedAt } : {}),
      ...(memory.confidence === undefined ? {} : { confidence: memory.confidence }),
      ...(memory.importance === undefined ? {} : { importance: memory.importance }),
      ...(memory.summary ? { summary: memory.summary } : {}),
      aliases: memory.aliases ?? [],
      tags: memory.tags ?? [],
      entities: memory.entities ?? [],
      relationships: memory.relationships ?? [],
      unresolved: memory.unresolved ?? false,
      provenance: memory.provenance ?? [],
      metadata: memory.metadata ?? {},
    }
    this.records.set(id, record)
    return Promise.resolve(record)
  }

  async update(id: string, memory: MemoryWrite): Promise<MemoryRecord> {
    const existing = this.records.get(id)
    if (!existing) throw new Error("memory not found")
    const updated = await this.write({ ...memory, id })
    this.records.set(id, {
      ...updated,
      ...(existing.createdAt ? { createdAt: existing.createdAt } : {}),
    })
    return this.records.get(id) as MemoryRecord
  }

  async supersede(id: string, replacement: MemoryWrite): Promise<MemoryRecord> {
    const existing = this.records.get(id)
    if (!existing) throw new Error("memory not found")
    const created = await this.write(replacement)
    this.records.set(id, { ...existing, freshness: "superseded" })
    return created
  }
}

function candidate(overrides: Partial<CandidateMemory["memory"]> = {}): CandidateMemory {
  return {
    id: randomUUID(),
    observationIds: [],
    confidence: 0.9,
    status: "approved",
    reasons: ["explicit user statement"],
    memory: {
      title: "Use logical replication for Phoenix",
      content: "Phoenix moves from PostgreSQL with logical replication and a monitored cutover.",
      type: "decision",
      scope: { kind: "project", id: "project" },
      observedAt: "2026-09-01T12:00:00.000Z",
      provenance: [
        {
          source: { kind: "session", externalId: randomUUID() },
          capturedAt: "2026-09-01T12:00:00.000Z",
          original: true,
        },
      ],
      ...overrides,
    },
  }
}

describe("DeterministicConsolidationPipeline", () => {
  it("merges duplicate candidates and preserves both provenance records", async () => {
    const provider = new InMemoryProvider()
    const pipeline = new DeterministicConsolidationPipeline(provider)
    const first = candidate()
    const second = candidate()

    const firstResult = await pipeline.consolidate([first])
    const secondResult = await pipeline.consolidate([second])

    expect(firstResult[0]?.status).toBe("promoted")
    expect(secondResult[0]?.reasons).toContain("merged exact duplicate")
    expect(provider.records.size).toBe(1)
    expect([...provider.records.values()][0]?.provenance).toHaveLength(2)
  })

  it("supersedes a newer explicit decision without deleting the original", async () => {
    const provider = new InMemoryProvider()
    const original = await provider.write({
      ...candidate().memory,
      observedAt: "2026-09-01T12:00:00.000Z",
    })
    const pipeline = new DeterministicConsolidationPipeline(provider)
    const newer = candidate({
      content: "Phoenix uses a blue-green deployment after logical replication catches up.",
      observedAt: "2026-09-02T12:00:00.000Z",
    })

    const result = await pipeline.consolidate([newer])

    expect(result[0]?.reasons).toContain("superseded older decision")
    expect(provider.records.get(original.id)?.freshness).toBe("superseded")
    expect(provider.records.size).toBe(2)
  })

  it("keeps unresolved conflicts rather than choosing a winner", async () => {
    const provider = new InMemoryProvider()
    const original = await provider.write(candidate().memory)
    const pipeline = new DeterministicConsolidationPipeline(provider)
    const conflicting = candidate({
      content: "Phoenix must use an offline pg_dump cutover instead of logical replication.",
      observedAt: "2026-09-01T12:00:00.000Z",
    })

    const result = await pipeline.consolidate([conflicting])
    const records = [...provider.records.values()]

    expect(result[0]?.reasons).toContain("preserved unresolved conflict")
    expect(records).toHaveLength(2)
    expect(records.every((record) => record.unresolved)).toBe(true)
    expect(provider.records.get(original.id)?.relationships?.[0]?.type).toBe("conflicts_with")
  })

  it("does not write another memory when a promoted batch is rerun", async () => {
    const provider = new InMemoryProvider()
    const pipeline = new DeterministicConsolidationPipeline(provider)
    const promoted = (await pipeline.consolidate([candidate()]))[0]
    if (!promoted) throw new Error("candidate was not consolidated")

    const rerun = await pipeline.consolidate([promoted])

    expect(rerun[0]?.status).toBe("promoted")
    expect(provider.records.size).toBe(1)
  })
})
