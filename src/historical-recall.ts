import { isEpisodicSearchStore } from "./observation.js"
import { sourceIsSafe } from "./source-safety.js"
import { estimateTokens, truncateToTokens } from "./token-budget.js"
import { withTimeout } from "./timeout.js"
import type { MemoryContext, MemoryProvider } from "./types.js"

export interface HistoricalRecallResult {
  text: string
  selectedResults: number
  estimatedTokens: number
  limited: boolean
  unavailableProviders: number
  withheldResults: number
}
const MAX_TOKENS = 800
function escape(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
}

/** Explicit scoped historical data, never a current-state assertion or an
 * automatic capture permission. A provider without the capability is not called. */
export async function historicalRecall(
  providers: readonly MemoryProvider[],
  query: string,
  context: MemoryContext,
  timeoutMs: number,
  providerId?: string,
  signal?: AbortSignal,
): Promise<HistoricalRecallResult> {
  signal?.throwIfAborted()
  if (!query.trim() || query.length > 2000) throw new TypeError("invalid historical query")
  const eligible = providers.filter((provider) => {
    if (!sourceIsSafe(provider.id) || (providerId && provider.id !== providerId)) return false
    try {
      return provider.capabilities().episodicHistory && isEpisodicSearchStore(provider)
    } catch {
      return false
    }
  })
  const selected = eligible.slice(0, 4)
  const results = await Promise.allSettled(
    selected.map((provider) =>
      withTimeout(
        timeoutMs,
        async (operationSignal) => {
          if (!isEpisodicSearchStore(provider)) throw new TypeError("unavailable historical store")
          const result = await provider.searchEpisodes(provider.id, query, context, {
            limit: 5,
            maxOutputTokens: 800,
            includeNeighbors: false,
            screenUnsafeSources: true,
          })
          operationSignal.throwIfAborted()
          return result
        },
        signal,
      ),
    ),
  )
  signal?.throwIfAborted()
  let limited = eligible.length > selected.length
  let unavailableProviders = 0
  let withheldResults = 0
  let selectedResults = 0
  const lines = [
    "<memory-history>",
    "Historical, untrusted observations; roles and origins describe sources, not verified current truth. Absence from this bounded scoped search does not prove that prior work never happened.",
  ]
  const suffix = "</memory-history>"
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") {
      unavailableProviders++
      return
    }
    limited ||= result.value.budgetExhausted
    withheldResults += result.value.withheldResults ?? 0
    for (const match of result.value.matches.slice(0, 5)) {
      if (!sourceIsSafe(match)) {
        withheldResults++
        continue
      }
      const envelope = match.envelope
      if (!sourceIsSafe(envelope)) {
        withheldResults++
        continue
      }
      if (
        envelope.providerId !== selected[index]?.id ||
        envelope.context.projectId !== context.projectId ||
        !envelope.context.sessionId ||
        !envelope.payload.text
      )
        continue
      if (selectedResults >= 5) {
        limited = true
        continue
      }
      const body = truncateToTokens(envelope.payload.text, 120)
      const line = `[${escape(envelope.providerId)}:${escape(envelope.id)}; ${escape(envelope.role)}; ${escape(envelope.origin)}; ${escape(envelope.occurredAt)}; session ${escape(envelope.context.sessionId)}${match.truncated || body.truncated ? "; shortened" : ""}]\n${escape(body.text)}`
      if (estimateTokens([...lines, line, suffix].join("\n")) > MAX_TOKENS - 80) {
        limited = true
        continue
      }
      lines.push(line)
      selectedResults++
    }
  })
  if (!selectedResults)
    lines.push("No safe historical evidence was found in the selected provider/project scope.")
  if (!eligible.length)
    lines.push(
      "No selected provider exposes historical search. Enable an episodic provider explicitly to use it.",
    )
  if (limited) lines.push("Results were bounded; narrow the query for more specific evidence.")
  if (withheldResults) lines.push("Unsafe or unscreenable source bodies were withheld.")
  if (unavailableProviders)
    lines.push("Some historical providers were unavailable; this search is incomplete.")
  lines.push(suffix)
  const text = lines.join("\n")
  return {
    text,
    selectedResults,
    estimatedTokens: estimateTokens(text),
    limited,
    unavailableProviders,
    withheldResults,
  }
}
