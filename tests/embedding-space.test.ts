import { describe, expect, it } from "vitest"
import {
  embeddingFingerprint,
  embedQuery,
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
})
