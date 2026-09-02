import { tokenize } from "../text.js"
import type { EmbeddingModel } from "../types.js"

export const DEFAULT_EMBEDDING_DIMENSIONS = 384

const CONCEPT_GROUPS = [
  [
    "auth",
    "authentication",
    "credential",
    "credentials",
    "identity",
    "iam",
    "login",
    "oauth",
    "token",
  ],
  ["amazon", "aws", "bedrock"],
  ["database", "db", "postgres", "postgresql", "sql"],
  ["failure", "incident", "issue", "problem", "troubleshooting"],
  ["decision", "decided", "choice", "chosen"],
  ["deploy", "deployment", "release", "shipping"],
  ["queue", "kafka", "messaging", "stream"],
] as const

const CONCEPTS = new Map<string, string>()
for (const [index, words] of CONCEPT_GROUPS.entries()) {
  for (const word of words) CONCEPTS.set(word, `concept:${index}`)
}

function hash(value: string, seed: number): number {
  let result = seed >>> 0
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16_777_619)
  }
  return result >>> 0
}

function features(text: string): string[] {
  const words = tokenize(text)
  const result = [...words, ...words]
  for (const word of words) {
    const concept = CONCEPTS.get(word)
    if (concept) result.push(...Array.from<string>({ length: 8 }).fill(concept))
    if (word.length >= 5) {
      const padded = `^${word}$`
      for (let index = 0; index <= padded.length - 3; index++) {
        result.push(`tri:${padded.slice(index, index + 3)}`)
      }
    }
  }
  for (let index = 0; index < words.length - 1; index++) {
    result.push(`pair:${words[index]}:${words[index + 1]}`)
  }
  return result
}

export class LocalHashEmbeddingModel implements EmbeddingModel {
  readonly id = "remem-local-hash-v1"
  readonly dimensions = DEFAULT_EMBEDDING_DIMENSIONS

  embed(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted()
    const vector = Array.from<number>({ length: this.dimensions }).fill(0)
    for (const feature of features(text)) {
      const index = hash(feature, 2_166_136_261) % this.dimensions
      const sign = hash(feature, 709_607) % 2 === 0 ? 1 : -1
      vector[index] = (vector[index] ?? 0) + sign
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    return Promise.resolve(magnitude === 0 ? vector : vector.map((value) => value / magnitude))
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0
  return dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

export function vectorLiteral(vector: number[], dimensions = DEFAULT_EMBEDDING_DIMENSIONS): string {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new TypeError(`embedding must contain ${dimensions} finite values`)
  }
  return `[${vector.join(",")}]`
}
