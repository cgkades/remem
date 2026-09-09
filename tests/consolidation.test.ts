import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { DeterministicConsolidationPipeline } from "../src/consolidation.js"
import type { CandidateMemory } from "../src/observation.js"
import type { MemoryProvider, MemoryRecord, MemoryScope, MemoryWrite } from "../src/types.js"

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

  findByConsolidationCandidateId(candidateId: string, scope: MemoryScope) {
    return Promise.resolve(
      [...this.records.values()].find((record) => {
        if (record.scope.kind !== scope.kind || record.scope.id !== scope.id) return false
        const consolidation = record.metadata?.consolidation
        if (!consolidation || typeof consolidation !== "object") return false
        const identity = consolidation as Record<string, unknown>
        return identity.candidateId === candidateId || identity.lastCandidateId === candidateId
      }),
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

  it("reuses a processed candidate without silently replacing its promoted memory", async () => {
    const provider = new InMemoryProvider()
    const candidateId = randomUUID()
    const original = await provider.write({
      ...candidate({
        title: "Project fact: Remember that Atlas uses SQLite.",
        content: "Remember that Atlas uses SQLite.",
        type: "semantic",
      }).memory,
      metadata: { consolidation: { candidateId, action: "promoted" } },
    })
    const pipeline = new DeterministicConsolidationPipeline(provider)
    const repeated = {
      ...candidate({
        title: "Project fact: Atlas uses SQLite.",
        content: "Atlas uses SQLite.",
        type: "semantic" as const,
        metadata: {
          capture: { extractorVersion: "deterministic-spans-v1" },
        },
      }),
      id: candidateId,
    }

    const result = await pipeline.consolidate([repeated])

    expect(result[0]?.reasons).toContain("reused processed candidate")
    expect(provider.records.size).toBe(1)
    expect(provider.records.get(original.id)).toEqual(original)
    expect(result[0]?.memory.content).toBe(original.content)
  })

  it("does not overwrite manual changes committed after a repeated-candidate lookup", async () => {
    const provider = new InMemoryProvider()
    const incoming = candidate({ content: "Atlas uses SQLite.", type: "semantic" })
    const original = await provider.write({
      ...incoming.memory,
      metadata: { consolidation: { candidateId: incoming.id, action: "promoted" } },
    })
    const edited = {
      ...original,
      content: "Atlas uses PostgreSQL.",
      type: "decision" as const,
      tags: ["reviewed"],
    }
    provider.findByConsolidationCandidateId = () => {
      provider.records.set(original.id, edited)
      return Promise.resolve(original)
    }

    const result = await new DeterministicConsolidationPipeline(provider).consolidate([incoming])

    expect(result[0]?.reasons).toContain("reused processed candidate")
    expect(provider.records.get(original.id)).toEqual(edited)
    expect(provider.records.size).toBe(1)
  })

  it("preserves richer merged content and the originating candidate identity on replay", async () => {
    const provider = new InMemoryProvider()
    const pipeline = new DeterministicConsolidationPipeline(provider)
    const first = candidate({
      type: "semantic",
      title: "Atlas storage policy",
      content:
        "Atlas uses encrypted PostgreSQL durable memory storage with backups migrations indexes scoped provenance monitoring verification replication recovery retention metadata and audit records.",
    })
    const second = candidate({
      ...first.memory,
      content: first.memory.content.replace("encrypted ", ""),
    })
    await pipeline.consolidate([first])
    expect((await pipeline.consolidate([second]))[0]?.reasons).toContain("merged near duplicate")
    const before = structuredClone([...provider.records.values()])

    const replay = await pipeline.consolidate([second, first])

    expect(replay.every((result) => result.reasons.includes("reused processed candidate"))).toBe(
      true,
    )
    expect([...provider.records.values()]).toEqual(before)
    expect(before[0]?.content).toBe(first.memory.content)
  })

  it("recognizes a historical candidate without reviving its superseded memory", async () => {
    const provider = new InMemoryProvider()
    const pipeline = new DeterministicConsolidationPipeline(provider)
    const older = candidate({ content: "Atlas uses SQLite." })
    await pipeline.consolidate([older])
    const newer = candidate({
      content: "Atlas uses PostgreSQL.",
      observedAt: "2026-09-02T12:00:00.000Z",
    })
    await pipeline.consolidate([newer])
    const before = structuredClone([...provider.records.values()])

    const replay = await pipeline.consolidate([older])

    expect(replay[0]?.reasons).toContain("reused processed candidate")
    expect([...provider.records.values()]).toEqual(before)
    expect(
      [...provider.records.values()].filter((record) => record.freshness === "current"),
    ).toHaveLength(1)
  })

  it.each(["provider", "scope"])(
    "rejects a repeated-candidate lookup crossing the %s boundary",
    async (boundary) => {
      const provider = new InMemoryProvider()
      const incoming = candidate()
      const original = await provider.write({
        ...incoming.memory,
        ...(boundary === "scope" ? { scope: { kind: "global" as const } } : {}),
      })
      provider.findByConsolidationCandidateId = () =>
        Promise.resolve({
          ...original,
          ...(boundary === "provider" ? { providerId: "foreign-provider" } : {}),
        })

      const result = await new DeterministicConsolidationPipeline(provider).consolidate([incoming])

      expect(result[0]?.status).toBe("approved")
      expect(provider.records.get(original.id)).toEqual(original)
      expect(provider.records.size).toBe(1)
    },
  )

  it("does not update a repeated candidate identity across scopes", async () => {
    const provider = new InMemoryProvider()
    const candidateId = randomUUID()
    const global = await provider.write({
      ...candidate({ scope: { kind: "global" } }).memory,
      metadata: { consolidation: { candidateId, action: "promoted" } },
    })
    const pipeline = new DeterministicConsolidationPipeline(provider)
    const projectCandidate = {
      ...candidate({ scope: { kind: "project", id: "project" } }),
      id: candidateId,
    }

    const result = await pipeline.consolidate([projectCandidate])

    expect(result[0]?.reasons).toContain("promoted candidate")
    expect(provider.records.size).toBe(2)
    expect(provider.records.get(global.id)?.scope).toEqual({ kind: "global" })
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
