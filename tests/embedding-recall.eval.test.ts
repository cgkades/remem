import { describe, expect, it } from "vitest"
import { LocalHashEmbeddingModel, cosineSimilarity } from "../src/storage/embedding.js"
import { createEmbeddingModel } from "../src/storage/embedding-neural.js"

// These paraphrase/low-lexical-overlap pairs are the shape of query the issue
// (#1) called out as broken under hash-only embeddings: a vague prompt that
// shares almost no tokens with the memory it should recall.
const RECALL_CASES: Array<{ prompt: string; memory: string }> = [
  {
    prompt: "what did we do about that AWS auth problem?",
    memory: "Bedrock Claude credential passthrough failure",
  },
  {
    prompt: "remind me how we fixed the flaky database test",
    memory: "PostgreSQL integration suite intermittent connection timeout resolution",
  },
  {
    prompt: "what was the decision on the caching layer",
    memory: "Chose Redis over in-memory LRU for session storage",
  },
]

const UNRELATED = "Summarize this unrelated weather report."

describe("embedding recall quality (hash vs neural)", () => {
  it.for(RECALL_CASES)(
    "neural embeddings score '%s' higher than an unrelated control",
    async ({ prompt, memory }, ctx) => {
      const neural = await createEmbeddingModel({ backend: "neural" })
      // No network in this environment; the fallback engaged. Report this
      // run as SKIPPED (not a silent pass) so CI output makes it visible
      // that the eval never actually validated anything.
      ctx.skip(
        neural.id !== "bge-small-en-v1.5",
        "neural embedding backend unavailable (no network / model download failed); fell back to hash embeddings",
      )
      const promptVector = await neural.embed(prompt)
      const memoryVector = await neural.embed(memory)
      const unrelatedVector = await neural.embed(UNRELATED)
      const relatedScore = cosineSimilarity(promptVector, memoryVector)
      const unrelatedScore = cosineSimilarity(promptVector, unrelatedVector)
      expect(relatedScore).toBeGreaterThan(unrelatedScore)
    },
  )

  it.each(RECALL_CASES)(
    "documents the hash baseline for '%s' (informational, not asserted)",
    async ({ prompt, memory }) => {
      const hash = new LocalHashEmbeddingModel()
      const promptVector = await hash.embed(prompt)
      const memoryVector = await hash.embed(memory)
      const score = cosineSimilarity(promptVector, memoryVector)
      // No assertion: this documents today's hash-only baseline score so a
      // future reader can see the gap neural embeddings close, without
      // making this suite flaky if the hand-authored concept map changes.
      expect(typeof score).toBe("number")
    },
  )
})
