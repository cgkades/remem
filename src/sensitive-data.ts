const CREDENTIAL_PATTERNS = [
  /(?:api[_ -]?key|secret|password|private[_ -]?key|access[_ -]?token|bearer token)\s*[:=]\s*[^\s,;]+/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/iu,
  /\b(?:AKIA|ASIA|A3T[A-Z0-9])[A-Z0-9]{16}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/iu,
  /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/u,
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/iu,
]

const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9_~+/-]{32,}/gu
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  return [...counts.values()].reduce((total, count) => {
    const probability = count / value.length
    return total - probability * Math.log2(probability)
  }, 0)
}

function looksLikeHighEntropyCredential(value: string): boolean {
  if (UUID.test(value)) return false
  const diversity = [/[a-z]/u, /[A-Z]/u, /\d/u, /[_~+/-]/u].filter((pattern) =>
    pattern.test(value),
  ).length
  return diversity >= 3 && entropy(value) >= 3.5
}

export function containsSensitiveCredential(value: string): boolean {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) return true
  return [...value.matchAll(HIGH_ENTROPY_TOKEN)].some((match) =>
    looksLikeHighEntropyCredential(match[0]),
  )
}

export function redactSensitiveText(value: string): string {
  let result = value
  for (const pattern of CREDENTIAL_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, `${pattern.flags}g`), "[redacted]")
  }
  return result.replace(HIGH_ENTROPY_TOKEN, (token) =>
    looksLikeHighEntropyCredential(token) ? "[redacted]" : token,
  )
}
