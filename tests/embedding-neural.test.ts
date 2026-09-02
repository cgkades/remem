import { describe, expect, it, vi } from "vitest"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import { createEmbeddingModel } from "../src/storage/embedding-neural.js"

describe("createEmbeddingModel", () => {
  it("returns LocalHashEmbeddingModel for backend 'hash'", async () => {
    const model = await createEmbeddingModel({ backend: "hash" })
    expect(model).toBeInstanceOf(LocalHashEmbeddingModel)
    expect(model.id).toBe("remem-local-hash-v1")
    expect(model.dimensions).toBe(384)
  })

  it("falls back to LocalHashEmbeddingModel when the neural loader throws", async () => {
    const model = await createEmbeddingModel(
      { backend: "neural" },
      { loadPipeline: vi.fn().mockRejectedValue(new Error("no network")) },
    )
    expect(model).toBeInstanceOf(LocalHashEmbeddingModel)
  })

  it("falls back to LocalHashEmbeddingModel when inference throws", async () => {
    const model = await createEmbeddingModel(
      { backend: "neural" },
      {
        loadPipeline: vi.fn().mockResolvedValue(
          vi.fn().mockRejectedValue(new Error("inference failed")),
        ),
      },
    )
    const embedding = await model.embed("hello world")
    expect(embedding).toHaveLength(384)
    expect(model.id).toBe("remem-local-hash-v1")
  })

  it("returns a working neural model when the loader succeeds", async () => {
    const fakeVector = new Array(384).fill(0).map((_, index) => (index === 0 ? 1 : 0))
    const model = await createEmbeddingModel(
      { backend: "neural" },
      {
        loadPipeline: vi.fn().mockResolvedValue(
          vi.fn().mockResolvedValue({ data: Float32Array.from(fakeVector) }),
        ),
      },
    )
    expect(model.id).toBe("bge-small-en-v1.5")
    expect(model.dimensions).toBe(384)
    const embedding = await model.embed("hello world")
    expect(embedding).toEqual(fakeVector)
  })
})
