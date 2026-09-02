function tokenWeight(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

export function estimateTokens(value: string): number {
  if (value.length === 0) return 0
  return Math.ceil(tokenWeight(value))
}

export function truncateToTokens(
  value: string,
  maxTokens: number,
): { text: string; estimatedTokens: number; truncated: boolean } {
  if (maxTokens <= 0) return { text: "", estimatedTokens: 0, truncated: value.length > 0 }
  if (estimateTokens(value) <= maxTokens) {
    return { text: value, estimatedTokens: estimateTokens(value), truncated: false }
  }

  const suffix = "..."
  const availableWeight = Math.max(0, maxTokens - tokenWeight(suffix))
  let usedWeight = 0
  let rough = ""
  for (const character of value) {
    const weight = tokenWeight(character)
    if (usedWeight + weight > availableWeight) break
    rough += character
    usedWeight += weight
  }
  const boundary = rough.lastIndexOf(" ")
  const body = boundary > rough.length * 0.7 ? rough.slice(0, boundary) : rough
  const text = `${body.trimEnd()}${suffix}`
  return { text, estimatedTokens: estimateTokens(text), truncated: true }
}
