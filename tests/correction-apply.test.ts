import { describe, expect, it, vi } from "vitest"
import { createProviderApplyMutation } from "../src/correction-apply.js"
import type { CandidateMutation } from "../src/correction.js"
import type {
  CatalogEntry,
  MemoryCapabilities,
  MemoryContext,
  MemoryMutationOptions,
  MemoryProvider,
  MemoryRecord,
  MemorySearchRequest,
  MemoryWrite,
} from "../src/types.js"

const context: MemoryContext = {
  directory: "/repo",
  worktree: "/repo",
  projectId: "phoenix",
  sessionId: "session-1",
}

function capabilities(overrides: Partial<MemoryCapabilities> = {}): MemoryCapabilities {
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
    ...overrides,
  }
}

function toRecord(id: string, write: MemoryWrite, providerId: string): MemoryRecord {
  return {
    ...write,
    providerId,
    id,
    source: write.source ?? `fixture:${id}`,
    freshness: write.freshness ?? "current",
  }
}

class FakeProvider implements MemoryProvider {
  readonly records = new Map<string, MemoryRecord>()
  refresh = vi.fn(() => Promise.resolve())

  constructor(
    readonly id: string,
    private readonly caps: MemoryCapabilities,
    seed: MemoryRecord[] = [],
  ) {
    for (const record of seed) this.records.set(record.id, record)
  }

  capabilities(): MemoryCapabilities {
    return this.caps
  }

  catalog(): Promise<CatalogEntry[]> {
    return Promise.resolve([])
  }

  search(_request: MemorySearchRequest) {
    return Promise.resolve([])
  }

  get(id: string, _context: MemoryContext): Promise<MemoryRecord | undefined> {
    return Promise.resolve(this.records.get(id))
  }

  write(memory: MemoryWrite, _options?: MemoryMutationOptions): Promise<MemoryRecord> {
    const id = `generated-${this.records.size + 1}`
    const record = toRecord(id, memory, this.id)
    this.records.set(id, record)
    return Promise.resolve(record)
  }

  update(id: string, memory: MemoryWrite, _options?: MemoryMutationOptions): Promise<MemoryRecord> {
    const record = toRecord(id, memory, this.id)
    this.records.set(id, record)
    return Promise.resolve(record)
  }

  supersede(
    id: string,
    replacement: MemoryWrite,
    _options?: MemoryMutationOptions,
  ): Promise<MemoryRecord> {
    const record = toRecord(id, replacement, this.id)
    this.records.set(id, record)
    return Promise.resolve(record)
  }

  delete(id: string): Promise<void> {
    this.records.delete(id)
    return Promise.resolve()
  }
}

function proposed(): MemoryWrite {
  return {
    title: "Correction: rollback plans are required",
    content: "Production rollouts require an approved rollback plan.",
    scope: { kind: "project", id: "phoenix" },
    type: "decision",
  }
}

describe("createProviderApplyMutation", () => {
  it("routes a create mutation to the first provider with write capability", async () => {
    const readOnly = new FakeProvider("readonly", capabilities())
    const writable = new FakeProvider("writable", capabilities({ write: true }))
    const apply = createProviderApplyMutation([readOnly, writable])

    const result = await apply({ kind: "create", proposed: proposed() }, context)
    expect(result.memoryId).toBe("generated-1")
    expect(writable.records.size).toBe(1)
    expect(writable.refresh).toHaveBeenCalledOnce()
  })

  it("throws when no provider supports write for a create mutation", async () => {
    const readOnly = new FakeProvider("readonly", capabilities())
    const apply = createProviderApplyMutation([readOnly])
    await expect(apply({ kind: "create", proposed: proposed() }, context)).rejects.toThrow(
      /no configured provider supports write/,
    )
  })

  it("routes an update/supersede mutation to whichever provider owns the target id", async () => {
    const existing = toRecord("target-1", proposed(), "owner")
    const other = new FakeProvider("other", capabilities({ update: true }))
    const owner = new FakeProvider("owner", capabilities({ update: true }), [existing])
    const apply = createProviderApplyMutation([other, owner])

    const mutation: CandidateMutation = {
      kind: "supersede",
      targetMemoryId: "target-1",
      proposed: proposed(),
    }
    const result = await apply(mutation, context)
    expect(result.memoryId).toBe("target-1")
    expect(owner.refresh).toHaveBeenCalledOnce()
    expect(other.refresh).not.toHaveBeenCalled()
  })

  it("throws when no configured provider owns the update/supersede/retire target", async () => {
    const provider = new FakeProvider("owner", capabilities())
    const apply = createProviderApplyMutation([provider])
    await expect(
      apply({ kind: "retire", targetMemoryId: "missing", note: "gone" }, context),
    ).rejects.toThrow(/no configured provider owns memory missing/)
  })

  it("routes a retire mutation to delete on the owning provider", async () => {
    const existing = toRecord("target-1", proposed(), "owner")
    const owner = new FakeProvider("owner", capabilities({ delete: true }), [existing])
    const apply = createProviderApplyMutation([owner])

    const result = await apply({ kind: "retire", targetMemoryId: "target-1", note: "old" }, context)
    expect(result.memoryId).toBe("target-1")
    expect(owner.records.has("target-1")).toBe(false)
    expect(owner.refresh).toHaveBeenCalledOnce()
  })

  it("throws when the owning provider does not support delete for a retire mutation", async () => {
    const existing = toRecord("target-1", proposed(), "owner")
    const owner: MemoryProvider = {
      id: "owner",
      capabilities: () => capabilities(),
      catalog: () => Promise.resolve([]),
      search: () => Promise.resolve([]),
      get: (id) => Promise.resolve(id === existing.id ? existing : undefined),
    }
    const apply = createProviderApplyMutation([owner])
    await expect(
      apply({ kind: "retire", targetMemoryId: "target-1", note: "old" }, context),
    ).rejects.toThrow(/does not support delete/)
  })

  it("rejects route_adjustment mutations -- there is no memory content to apply", async () => {
    const apply = createProviderApplyMutation([])
    await expect(
      apply({ kind: "route_adjustment", note: "fix the gate" }, context),
    ).rejects.toThrow(/cannot be applied to a provider automatically/)
  })
})
