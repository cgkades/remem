import { describe, expect, it } from "vitest"
import { MemoryManager } from "../src/memory-manager.js"
import type { MemoryProvider, MemoryRecord, MemoryWrite } from "../src/types.js"
import { memoryContext } from "./helpers.js"

function record(memory: MemoryWrite, id = "memory-1"): MemoryRecord {
  return {
    providerId: "mutable",
    id,
    title: memory.title,
    content: memory.content,
    source: memory.source ?? "test://memory",
    scope: memory.scope,
    type: memory.type,
    freshness: memory.freshness ?? "current",
  }
}

describe("MemoryManager", () => {
  it("uses explicit mutation methods and refreshes the provider", async () => {
    let stored: MemoryRecord | undefined
    let refreshes = 0
    const provider: MemoryProvider = {
      id: "mutable",
      capabilities: () => ({
        lexicalSearch: true,
        semanticSearch: false,
        metadataFiltering: true,
        catalog: true,
        read: true,
        write: true,
        update: true,
        delete: true,
        episodicHistory: false,
        structuredEntities: false,
        filesystemDocuments: false,
      }),
      catalog: () => Promise.resolve([]),
      search: () => Promise.resolve([]),
      get: () => Promise.resolve(stored),
      write: (memory) => {
        stored = record(memory)
        return Promise.resolve(stored)
      },
      update: (id, memory) => {
        stored = record(memory, id)
        return Promise.resolve(stored)
      },
      supersede: (_id, replacement) => {
        stored = record(replacement, "memory-2")
        return Promise.resolve(stored)
      },
      delete: () => {
        stored = undefined
        return Promise.resolve()
      },
      refresh: () => {
        refreshes++
      },
    }
    const manager = new MemoryManager([provider], "mutable")
    const input: MemoryWrite = {
      title: "Decision",
      content: "Use PostgreSQL.",
      type: "decision",
      scope: { kind: "project", id: memoryContext.projectId },
    }

    expect((await manager.create(input)).id).toBe("memory-1")
    expect((await manager.update("memory-1", { ...input, content: "Use pgvector." })).content).toBe(
      "Use pgvector.",
    )
    expect((await manager.supersede("memory-1", input)).id).toBe("memory-2")
    expect((await manager.get("memory-2", memoryContext))?.id).toBe("memory-2")
    await manager.delete("memory-2", memoryContext)
    expect(refreshes).toBe(4)
  })
})
