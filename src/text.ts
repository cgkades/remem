import { redactSensitiveText } from "./sensitive-data.js"

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "let",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "this",
  "to",
  "we",
  "what",
  "with",
  "you",
])

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

export function containsPhrase(value: string, phrase: string): boolean {
  const normalizedValue = normalizeText(value)
  const normalizedPhrase = normalizeText(phrase)
  return normalizedPhrase.length > 0 && ` ${normalizedValue} `.includes(` ${normalizedPhrase} `)
}

export function tokenize(value: string): string[] {
  const tokens = normalizeText(value).split(/\s+/u)
  return [...new Set(tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token)))]
}

export function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0
  const rightSet = new Set(right)
  const matches = left.filter((token) => rightSet.has(token)).length
  return matches / left.length
}

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim()
}

export function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 ? " " : character
    })
    .join("")
}

export function contentFingerprint(value: string): string {
  return normalizeText(value).replace(/\s+/gu, " ")
}

/**
 * A bounded `"Name: message"` summary of a caught error, for persisting to
 * durable run/audit records (e.g. `consolidation_records.metadata`) where
 * `error.name` alone ("TypeError") gives no way to tell two different
 * failures apart. These are internal processing errors (an embedding
 * backend failure, a consolidation pipeline error), not raw user input, but
 * a library or driver error can still echo back a connection string,
 * file path, or other operational detail it was given -- `error.message`
 * is redacted the same way captured session text is (`sensitive-data.ts`)
 * before this becomes a relied-on diagnostics surface, and control
 * characters are stripped so a persisted record can't smuggle terminal
 * escape sequences into a human reviewer's tooling. Capped since a
 * pathological `.message` (e.g. a library that embeds a full stack trace)
 * should not balloon a persisted JSONB column unbounded.
 */
export function describeError(error: unknown, maxLength = 500): string {
  if (!(error instanceof Error)) return "unknown error"
  const message = error.message ? redactSensitiveText(stripControlCharacters(error.message)) : ""
  const description = message ? `${error.name}: ${message}` : error.name
  return description.length > maxLength ? `${description.slice(0, maxLength)}…` : description
}
