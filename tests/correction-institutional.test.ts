import { describe, expect, it } from "vitest"
import { createInstitutionalLoaders } from "../src/correction-institutional.js"
import type {
  CatalogEntry,
  InstitutionalPosition,
  MemoryCapabilities,
  MemoryContext,
  MemoryProvider,
  MemoryRecord,
  MemorySearchRequest,
} from "../src/types.js"

const context: MemoryContext = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "phoenix",
  sessionId: "session-1",
}

function capabilities(): MemoryCapabilities {
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

function institutional(id: string): InstitutionalPosition {
  return {
    role: "position",
    id,
    owner: "release-engineering",
    sourceRefs: ["policy://release/rollback-position"],
    boundaryConditions: ["Production changes only."],
    applicability: {
      match: "all",
      conditions: [{ id: "project", kind: "context", field: "projectId", value: "phoenix" }],
    },
    review: { reviewedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2027-09-01T00:00:00.000Z" },
  }
}

function record(id: string, institutionalId?: string): MemoryRecord {
  return {
    providerId: "fixtures",
    id,
    title: `Record ${id}`,
    content: "content",
    source: `fixtures:${id}`,
    scope: { kind: "project", id: "phoenix" },
    type: "decision",
    freshness: "current",
    provenance: [
      {
        source: { kind: "document", uri: "policy://x" },
        capturedAt: "2026-09-01T00:00:00.000Z",
        original: true,
      },
    ],
    ...(institutionalId ? { institutional: institutional(institutionalId) } : {}),
  }
}

function catalogEntry(record: MemoryRecord): CatalogEntry {
  return {
    id: record.id,
    title: record.title,
    aliases: [],
    summary: record.title,
    providerIds: [record.providerId],
    scope: record.scope,
    tags: [],
    importance: 0.5,
    unresolved: false,
    ...(record.institutional ? { institutional: record.institutional } : {}),
  }
}

class FakeProvider implements MemoryProvider {
  constructor(
    readonly id: string,
    private readonly records: MemoryRecord[],
  ) {}

  capabilities(): MemoryCapabilities {
    return capabilities()
  }

  catalog(): Promise<CatalogEntry[]> {
    return Promise.resolve(this.records.map(catalogEntry))
  }

  search(_request: MemorySearchRequest) {
    return Promise.resolve([])
  }

  get(id: string): Promise<MemoryRecord | undefined> {
    return Promise.resolve(this.records.find((candidate) => candidate.id === id))
  }
}

describe("createInstitutionalLoaders", () => {
  it("loads institutional records across providers, skipping non-institutional and non-get providers", async () => {
    const withGet = new FakeProvider("with-get", [
      record("plain-1"),
      record("position-1", "position.a"),
    ])
    const withoutGet = { ...withGet, get: undefined } as unknown as MemoryProvider
    const { loadInstitutional, loadInstitutionalWrites } = createInstitutionalLoaders([
      withGet,
      withoutGet,
    ])

    const institutionalMemories = await loadInstitutional(context)
    expect(institutionalMemories).toHaveLength(1)
    expect(institutionalMemories[0]?.id).toBe("position.a")

    const writes = await loadInstitutionalWrites(context)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      title: "Record position-1",
      type: "decision",
      institutional: { id: "position.a" },
    })
    expect(writes[0]?.provenance).toBeDefined()
  })

  it("returns empty arrays when no provider has institutional entries", async () => {
    const provider = new FakeProvider("plain", [record("plain-1")])
    const { loadInstitutional, loadInstitutionalWrites } = createInstitutionalLoaders([provider])
    expect(await loadInstitutional(context)).toEqual([])
    expect(await loadInstitutionalWrites(context)).toEqual([])
  })
})
