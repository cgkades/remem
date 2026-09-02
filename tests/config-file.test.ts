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
})
