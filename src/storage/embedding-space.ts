import { createHash } from "node:crypto"
import type { EmbeddingModel } from "../types.js"

export interface EmbeddingEncoding {
  mode: string
  instruction: string
}
/** Immutable identity of a paired query/document space, not just a model label. */
export interface EmbeddingSpace {
  schemaVersion: 1
  backend: string
  asset: string
  dimensions: number
  pooling: string
  normalization: string
  dtype: string
  query: EmbeddingEncoding
  document: EmbeddingEncoding
}
export function embeddingFingerprint(space: EmbeddingSpace): string {
  if (space.schemaVersion !== 1 || !Number.isInteger(space.dimensions) || space.dimensions < 1)
    throw new TypeError("invalid embedding space version or dimensions")
  for (const value of [
    space.backend,
    space.asset,
    space.pooling,
    space.normalization,
    space.dtype,
    space.query.mode,
    space.document.mode,
  ])
    if (typeof value !== "string" || !value.trim())
      throw new TypeError("incomplete embedding space")
  if (typeof space.query.instruction !== "string" || typeof space.document.instruction !== "string")
    throw new TypeError("invalid embedding instruction")
  // Explicit field order excludes unrelated metadata and object insertion order.
  const canonical = JSON.stringify({
    schemaVersion: 1,
    backend: space.backend,
    asset: space.asset,
    dimensions: space.dimensions,
    pooling: space.pooling,
    normalization: space.normalization,
    dtype: space.dtype,
    query: { mode: space.query.mode, instruction: space.query.instruction },
    document: { mode: space.document.mode, instruction: space.document.instruction },
  })
  return "remem-space-v1:" + createHash("sha256").update(canonical).digest("hex")
}
export function modelFingerprint(model: EmbeddingModel): string | undefined {
  if (!model.space) return undefined
  if (model.space.dimensions !== model.dimensions)
    throw new TypeError("embedding space dimension mismatch")
  return embeddingFingerprint(model.space)
}
function checked(model: EmbeddingModel, pending: Promise<number[]>): Promise<number[]> {
  return pending.then((vector) => {
    if (
      vector.length !== model.dimensions ||
      vector.some((value) => !Number.isFinite(value)) ||
      !vector.some((value) => value !== 0)
    )
      throw new TypeError("invalid embedding encoder output")
    return vector
  })
}
export function embedQuery(
  model: EmbeddingModel,
  text: string,
  signal?: AbortSignal,
): Promise<number[]> {
  if (model.embedQuery) return checked(model, model.embedQuery(text, signal))
  if (model.space && JSON.stringify(model.space.query) !== JSON.stringify(model.space.document))
    throw new TypeError("asymmetric space requires a query encoder")
  return checked(model, model.embed(text, signal))
}
export function embedDocument(
  model: EmbeddingModel,
  text: string,
  signal?: AbortSignal,
): Promise<number[]> {
  return checked(
    model,
    model.embedDocument ? model.embedDocument(text, signal) : model.embed(text, signal),
  )
}
