import { afterEach, describe, expect, it, vi } from "vitest"
import * as undici from "undici"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import {
  BgeSmallEmbeddingModel,
  configureProxyFromEnvironment,
  createEmbeddingModel,
} from "../src/storage/embedding-neural.js"

// Spy on setGlobalDispatcher while letting ProxyAgent's real constructor
// run, so tests verify the call without faking the whole undici module.
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof undici>()
  return { ...actual, setGlobalDispatcher: vi.fn() }
})

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

  it("calls onFallback with the error when the neural loader throws", async () => {
    const onFallback = vi.fn()
    const error = new Error("no network")
    const model = await createEmbeddingModel(
      { backend: "neural" },
      { loadPipeline: vi.fn().mockRejectedValue(error), onFallback },
    )
    expect(model).toBeInstanceOf(LocalHashEmbeddingModel)
    expect(onFallback).toHaveBeenCalledWith(error)
  })

  it("still returns the hash fallback when onFallback itself throws", async () => {
    const onFallback = vi.fn(() => {
      throw new Error("logging is broken")
    })
    const model = await createEmbeddingModel(
      { backend: "neural" },
      { loadPipeline: vi.fn().mockRejectedValue(new Error("no network")), onFallback },
    )
    expect(model).toBeInstanceOf(LocalHashEmbeddingModel)
  })
})

describe("BgeSmallEmbeddingModel", () => {
  it("throws a TypeError when the extractor returns the wrong vector length", async () => {
    const extractor = vi.fn().mockResolvedValue({ data: new Float32Array(512) })
    const model = new BgeSmallEmbeddingModel(extractor)
    await expect(model.embed("hello world")).rejects.toThrow(TypeError)
  })
})

describe("configureProxyFromEnvironment", () => {
  afterEach(() => {
    vi.mocked(undici.setGlobalDispatcher).mockClear()
  })

  // NOTE: configureProxyFromEnvironment guards against reconfiguring the
  // dispatcher more than once per process (see source comment), and that
  // guard is module-level state shared across the tests in this file. Test
  // order below is intentional: the "no proxy" assertions must run before
  // any test that supplies a proxy URL, since once the guard flips on it
  // stays on for the rest of this module's lifetime.
  it("returns false when no proxy env vars are set", () => {
    const result = configureProxyFromEnvironment({})
    expect(result).toBe(false)
    expect(undici.setGlobalDispatcher).not.toHaveBeenCalled()
  })

  it("calls setGlobalDispatcher once with a ProxyAgent when HTTPS_PROXY is set", () => {
    const result = configureProxyFromEnvironment({ HTTPS_PROXY: "http://proxy.example.com:8080" })
    expect(result).toBe(true)
    expect(undici.setGlobalDispatcher).toHaveBeenCalledTimes(1)
    expect(undici.setGlobalDispatcher).toHaveBeenCalledWith(expect.any(undici.ProxyAgent))
  })

  it("does not call setGlobalDispatcher again on a subsequent call", () => {
    // The previous test already configured a proxy for this process, so the
    // guard should short-circuit before calling setGlobalDispatcher again.
    const result = configureProxyFromEnvironment({ HTTPS_PROXY: "http://proxy.example.com:8080" })
    expect(result).toBe(true)
    expect(undici.setGlobalDispatcher).not.toHaveBeenCalled()
  })
})
