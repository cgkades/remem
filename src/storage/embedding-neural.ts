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
}

const MODEL_ID = "bge-small-en-v1.5"
const MODEL_DIMENSIONS = 384
const HUGGING_FACE_MODEL = "Xenova/bge-small-en-v1.5"

async function defaultLoadPipeline(modelPath: string | undefined): Promise<FeatureExtractionPipeline> {
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
  if (config.backend !== "neural") return new LocalHashEmbeddingModel()
  try {
    const loadPipeline = options.loadPipeline ?? defaultLoadPipeline
    const extractor = await loadPipeline(config.modelPath)
    // Fail fast here rather than lazily on first embed() so callers see the
    // fallback decision immediately instead of on a random later request.
    await extractor("remem embedding model warmup", { pooling: "mean", normalize: true })
    return new BgeSmallEmbeddingModel(extractor)
  } catch {
    return new LocalHashEmbeddingModel()
  }
}
