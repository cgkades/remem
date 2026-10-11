import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  embeddingFingerprint,
  embedQuery,
  embedDocument,
  modelFingerprint,
} from "../src/storage/embedding-space.js"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import { createEmbeddingModel } from "../src/storage/embedding-neural.js"
describe("canonical embedding spaces", () => {
  const space = new LocalHashEmbeddingModel().space
  it("is independent of property order but every encoding field changes compatibility", () => {
    expect(embeddingFingerprint({ ...space, query: { instruction: "", mode: "text" } })).toBe(
      embeddingFingerprint(space),
    )
    for (const changed of [
      { backend: "other" },
      { asset: "revision2" },
      { dimensions: 128 },
      { pooling: "cls" },
      { normalization: "none" },
      { dtype: "float32" },
      { query: { mode: "query", instruction: "search: " } },
      { document: { mode: "document", instruction: "passage: " } },
    ])
      expect(embeddingFingerprint({ ...space, ...changed })).not.toBe(embeddingFingerprint(space))
  })
  it("rejects incomplete and unsupported identities", () => {
    expect(() => embeddingFingerprint({ ...space, asset: "" })).toThrow()
    expect(() => embeddingFingerprint({ ...space, schemaVersion: 2 } as never)).toThrow()
    expect(
      modelFingerprint({ id: "unidentified", dimensions: 384, embed: () => Promise.resolve([]) }),
    ).toBeUndefined()
  })
  it("requires an actual query encoder for an asymmetric space", () => {
    expect(() =>
      embedQuery(
        {
          id: "asymmetric",
          dimensions: 384,
          space: { ...space, query: { mode: "query", instruction: "search: " } },
          embed: () => Promise.resolve([]),
        },
        "query",
      ),
    ).toThrow("query encoder")
  })
  it("assigns the actual hash fallback identity, never the requested neural identity", async () => {
    const model = await createEmbeddingModel(
      { backend: "neural" },
      {
        loadPipeline: () => Promise.reject(new Error("unavailable")),
      },
    )
    expect(modelFingerprint(model)).toBe(embeddingFingerprint(space))
  })
  it("identifies offline asset contents independently of directory paths and detects changes while loading", async () => {
    const a = await mkdtemp(path.join(tmpdir(), "remem-model-a-"))
    const b = await mkdtemp(path.join(tmpdir(), "remem-model-b-"))
    const loadPipeline = () =>
      Promise.resolve(() => Promise.resolve({ data: new Float32Array(384) }))
    try {
      await writeFile(path.join(a, "weights.bin"), "same weights")
      await writeFile(path.join(b, "weights.bin"), "same weights")
      const first = await createEmbeddingModel(
        { backend: "neural", modelPath: a },
        { loadPipeline },
      )
      const relocated = await createEmbeddingModel(
        { backend: "neural", modelPath: b },
        { loadPipeline },
      )
      expect(first.id).toBe("bge-small-en-v1.5")
      expect(modelFingerprint(first)).toBe(modelFingerprint(relocated))
      await writeFile(path.join(b, "weights.bin"), "new weights")
      const changed = await createEmbeddingModel(
        { backend: "neural", modelPath: b },
        { loadPipeline },
      )
      expect(modelFingerprint(first)).not.toBe(modelFingerprint(changed))
      const raced = await createEmbeddingModel(
        { backend: "neural", modelPath: a },
        {
          loadPipeline: async () => {
            await writeFile(path.join(a, "weights.bin"), "racing change")
            return () => Promise.resolve({ data: new Float32Array(384) })
          },
        },
      )
      expect(raced.id).toBe("remem-local-hash-v1")
    } finally {
      await rm(a, { recursive: true, force: true })
      await rm(b, { recursive: true, force: true })
    }
  })
  it("rejects non-finite, wrong-width and zero encoder vectors before querying PostgreSQL", async () => {
    for (const vector of [
      [1],
      Array.from<number>({ length: 384 }).fill(NaN),
      Array.from<number>({ length: 384 }).fill(0),
    ]) {
      const m = { id: "invalid", dimensions: 384, space, embed: () => Promise.resolve(vector) }
      await expect(embedQuery(m, "query")).rejects.toThrow("invalid embedding encoder output")
      await expect(embedDocument(m, "document")).rejects.toThrow("invalid embedding encoder output")
    }
  })
})
