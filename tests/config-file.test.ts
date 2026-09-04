import { describe, expect, it } from "vitest"
import { validateAppConfig } from "../src/storage/config-file.js"

describe("validateAppConfig", () => {
  const base = {
    version: 1 as const,
    storage: { mode: "external" as const, connectionString: "postgres://x" },
    providers: [],
  }

  it("accepts the local-hash embedding shape", () => {
    expect(() =>
      validateAppConfig({
        ...base,
        embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
      }),
    ).not.toThrow()
  })

  it("accepts the neural embedding shape", () => {
    expect(() =>
      validateAppConfig({
        ...base,
        embedding: { provider: "neural", model: "bge-small-en-v1.5", dimensions: 384 },
      }),
    ).not.toThrow()
  })

  it("rejects an unknown embedding provider", () => {
    expect(() =>
      validateAppConfig({
        ...base,
        embedding: { provider: "openai", model: "text-embedding-3", dimensions: 1536 },
      }),
    ).toThrow()
  })

  it("rejects a local-hash provider paired with the neural model", () => {
    // A hand-edited/corrupted config.json with a mismatched literal pair:
    // provider says "local-hash" but model/dimensions say "neural". Trusting
    // provider alone would mislead downstream code (warnAboutNeuralDownload,
    // doctor's "embedding settings persistence" check) that reads
    // model/dimensions unconditionally after this assertion passes.
    expect(() =>
      validateAppConfig({
        ...base,
        embedding: { provider: "local-hash", model: "bge-small-en-v1.5", dimensions: 384 },
      }),
    ).toThrow(/embedding.model\/dimensions do not match provider 'local-hash'/)
  })

  it("rejects a neural provider paired with the local-hash model", () => {
    expect(() =>
      validateAppConfig({
        ...base,
        embedding: { provider: "neural", model: "remem-local-hash-v1", dimensions: 384 },
      }),
    ).toThrow(/embedding.model\/dimensions do not match provider 'neural'/)
  })

  it("rejects a mismatched dimensions value even when provider and model match", () => {
    expect(() =>
      validateAppConfig({
        ...base,
        embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 1536 },
      }),
    ).toThrow(/embedding.model\/dimensions do not match provider 'local-hash'/)
  })
})
