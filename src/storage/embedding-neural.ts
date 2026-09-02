import { ProxyAgent, setGlobalDispatcher } from "undici"
import { LocalHashEmbeddingModel } from "./embedding.js"
import type { EmbeddingModel } from "../types.js"

export interface NeuralEmbeddingConfig {
  backend: "hash" | "neural"
  modelPath?: string
}

export type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: true },
) => Promise<{ data: ArrayLike<number> }>

export interface EmbeddingModelFactoryOptions {
  /** Test/DI seam: loads (or fakes) the transformers.js feature-extraction pipeline. */
  loadPipeline?: (modelPath: string | undefined) => Promise<FeatureExtractionPipeline>
  /**
   * Called with the error that triggered a fallback to LocalHashEmbeddingModel.
   * Never allowed to break the fallback: any synchronous error thrown from
   * this callback is swallowed. (An async onFallback that rejects after
   * returning would produce an unhandled rejection — the inner try/catch
   * here does not catch that case.) Use this for observability (network
   * failure vs. corrupted model vs. OOM are operationally very different) —
   * never for control flow.
   */
  onFallback?: (error: unknown) => void
}

const MODEL_ID = "bge-small-en-v1.5"
const MODEL_DIMENSIONS = 384
const HUGGING_FACE_MODEL = "Xenova/bge-small-en-v1.5"

// Module-level guard: setGlobalDispatcher replaces the process-wide undici
// dispatcher without closing/destroying the one it replaces, so repeated
// calls (e.g. multiple RememPlugin instances in one long-running process)
// would orphan ProxyAgent connection pools. Configure at most once per process.
let proxyConfigured = false

/**
 * Routes @huggingface/transformers's model-weight downloads through the
 * standard proxy env vars. Returns whether a proxy was configured (by this
 * call or a previous one in this process).
 */
export function configureProxyFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (proxyConfigured) return true
  const proxyUrl = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (!proxyUrl) return false
  setGlobalDispatcher(new ProxyAgent(proxyUrl))
  proxyConfigured = true
  return true
}

async function defaultLoadPipeline(modelPath: string | undefined): Promise<FeatureExtractionPipeline> {
  configureProxyFromEnvironment()
  const { pipeline, env } = await import("@huggingface/transformers")
  if (modelPath) {
    env.localModelPath = modelPath
    env.allowRemoteModels = false
  }
  const extractor = await pipeline("feature-extraction", HUGGING_FACE_MODEL, { dtype: "q8" })
  return (text, options) =>
    extractor(text, options).then((output) => output as unknown as { data: ArrayLike<number> })
}

export class BgeSmallEmbeddingModel implements EmbeddingModel {
  readonly id = MODEL_ID
  readonly dimensions = MODEL_DIMENSIONS

  constructor(private readonly extractor: FeatureExtractionPipeline) {}

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted()
    const output = await this.extractor(text, { pooling: "mean", normalize: true })
    const vector = Array.from(output.data)
    if (vector.length !== this.dimensions) {
      throw new TypeError(
        `bge-small-en-v1.5 returned ${vector.length} dimensions, expected ${this.dimensions}`,
      )
    }
    return vector
  }
}

/**
 * Resolves the configured embedding backend. Any failure to load the neural
 * pipeline, download weights, or run inference falls back to
 * LocalHashEmbeddingModel — an embedding backend failure must never break
 * OpenCode prompt execution.
 */
export async function createEmbeddingModel(
  config: NeuralEmbeddingConfig,
  options: EmbeddingModelFactoryOptions = {},
): Promise<EmbeddingModel> {
  // Explicit selection of the hash backend, not a fallback — onFallback is
  // intentionally not invoked here; it only fires from the catch below.
  if (config.backend !== "neural") return new LocalHashEmbeddingModel()
  try {
    const loadPipeline = options.loadPipeline ?? defaultLoadPipeline
    const extractor = await loadPipeline(config.modelPath)
    // Fail fast here rather than lazily on first embed() so callers see the
    // fallback decision immediately instead of on a random later request.
    await extractor("remem embedding model warmup", { pooling: "mean", normalize: true })
    return new BgeSmallEmbeddingModel(extractor)
  } catch (error) {
    try {
      options.onFallback?.(error)
    } catch {
      // Observability must never break the fallback path.
    }
    return new LocalHashEmbeddingModel()
  }
}
