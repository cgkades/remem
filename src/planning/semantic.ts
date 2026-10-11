import { embedQuery, embedDocument, modelFingerprint } from "../storage/embedding-space.js"
import { cosineSimilarity, LocalHashEmbeddingModel } from "../storage/embedding.js"
import type { CatalogEntry, CatalogMatch, EmbeddingModel, ProviderDescriptor } from "../types.js"

export interface SemanticProviderMatch {
  provider: ProviderDescriptor
  score: number
}

export interface SemanticRecognitionResult {
  matches: CatalogMatch[]
  providerMatches: SemanticProviderMatch[]
  confidence: number
}

export class SemanticCatalogRecognizer {
  private readonly cache = new Map<string, Promise<number[]>>()

  constructor(private readonly embeddingModel: EmbeddingModel = new LocalHashEmbeddingModel()) {}

  async recognize(
    prompt: string,
    entries: CatalogEntry[],
    providers: ProviderDescriptor[],
    signal?: AbortSignal,
  ): Promise<SemanticRecognitionResult> {
    signal?.throwIfAborted()
    const promptEmbedding = await embedQuery(this.embeddingModel, prompt, signal)
    const matches = await Promise.all(
      entries.map(async (entry) => {
        const embedding =
          (entry.embeddingFingerprint === modelFingerprint(this.embeddingModel) &&
          entry.embeddingFingerprint
            ? entry.embedding
            : undefined) ??
          (await this.cachedEmbedding(
            `entry:${entry.id}:${entry.title}:${entry.summary}:${entry.aliases.join(",")}:${entry.tags.join(",")}`,
            [entry.title, entry.aliases.join(" "), entry.summary, entry.tags.join(" ")].join("\n"),
          ))
        return {
          entry,
          score: Math.max(0, cosineSimilarity(promptEmbedding, embedding)),
          reasons: ["semantic catalog similarity"],
        }
      }),
    )
    const providerMatches = await Promise.all(
      providers.map(async (provider) => {
        const embedding =
          (provider.embeddingFingerprint === modelFingerprint(this.embeddingModel) &&
          provider.embeddingFingerprint
            ? provider.embedding
            : undefined) ??
          (await this.cachedEmbedding(
            `provider:${provider.id}:${provider.summary}:${provider.categories.join(",")}`,
            [
              provider.name,
              provider.aliases.join(" "),
              provider.summary,
              provider.categories.join(" "),
            ].join("\n"),
          ))
        return {
          provider,
          score: Math.max(0, cosineSimilarity(promptEmbedding, embedding)),
        }
      }),
    )
    matches.sort((left, right) => right.score - left.score)
    providerMatches.sort((left, right) => right.score - left.score)
    return {
      matches,
      providerMatches,
      confidence: Math.max(matches[0]?.score ?? 0, providerMatches[0]?.score ?? 0),
    }
  }

  private cachedEmbedding(key: string, text: string): Promise<number[]> {
    const cached = this.cache.get(key)
    if (cached) return cached
    const embedding = embedDocument(this.embeddingModel, text)
    this.cache.set(key, embedding)
    while (this.cache.size > 5_000) {
      const oldest = this.cache.keys().next().value
      if (!oldest) break
      this.cache.delete(oldest)
    }
    void embedding.catch(() => this.cache.delete(key))
    return embedding
  }
}
