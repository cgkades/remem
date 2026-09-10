import type { PlannerConfig } from "./config.js"
import {
  applicabilityConditionSatisfied,
  institutionalApplies,
  institutionalReviewStatus,
} from "./institutional.js"
import { clamp, containsPhrase, overlapRatio, tokenize } from "./text.js"
import type {
  CatalogEntry,
  CatalogMatch,
  ApplicabilityDecision,
  MemoryContext,
  ProviderRetrievalRequest,
  RetrievalPlan,
} from "./types.js"

const STRONG_CONTINUITY =
  /\b(last time|we decided|we agreed|remember|continue|resume|again|pick up where|the thing we)\b/iu
const GENERIC_ROUTING_TOKENS = new Set(["project", "service", "work", "migration"])

/**
 * Tokens excluded from short-continuity anchor derivation (TASK-005). This is a
 * superset of `GENERIC_ROUTING_TOKENS`: it also excludes continuity/meta words that
 * would otherwise "anchor" every continuity prompt to whichever catalog entry happens
 * to share them, defeating the point of a distinctive anchor. Some entries here are
 * already removed by `tokenize`'s own stopword list; they are listed again for an
 * exact match against the plan's specification rather than relying on that overlap.
 */
const ANCHOR_EXCLUDED_TOKENS = new Set([
  "project",
  "service",
  "work",
  "migration",
  "memory",
  "fact",
  "decision",
  "preference",
  "task",
  "procedure",
  "explicit",
  "user",
  "continue",
  "resume",
  "again",
  "remember",
  "last",
  "time",
  "thing",
  "pick",
  "where",
  "left",
  "off",
  "lets",
  "the",
  "and",
  "this",
  "that",
])

/** Tokens from a catalog entry's title and aliases, used for anchor document-frequency. */
function catalogTermTokens(entry: CatalogEntry): Set<string> {
  return new Set([entry.title, ...entry.aliases].flatMap((value) => tokenize(value)))
}

interface ContinuityAnchor {
  anchor: string
  entries: CatalogEntry[]
}

/**
 * Bounded short-continuity fallback (TASK-005): when a continuity prompt has no
 * qualified catalog match, find one prompt token that also names an eligible catalog
 * entry (by title/alias), and route only to providers owning entries with that token.
 * This does not solve pronouns, ambiguous projects, or semantic entity inference; with
 * no anchor, callers must keep the existing full-prompt/all-providers fallback.
 */
function selectContinuityAnchor(
  promptTokens: string[],
  entries: CatalogEntry[],
): ContinuityAnchor | undefined {
  const entryTerms = entries.map((entry) => ({ entry, terms: catalogTermTokens(entry) }))
  const candidates = promptTokens.filter(
    (token) => token.length >= 3 && !ANCHOR_EXCLUDED_TOKENS.has(token),
  )

  let best: { anchor: string; frequency: number; order: number } | undefined
  for (const [order, token] of candidates.entries()) {
    const frequency = entryTerms.filter(({ terms }) => terms.has(token)).length
    if (frequency === 0) continue
    if (
      !best ||
      frequency < best.frequency ||
      (frequency === best.frequency && order < best.order)
    ) {
      best = { anchor: token, frequency, order }
    }
  }
  if (!best) return undefined

  return {
    anchor: best.anchor,
    entries: entryTerms.filter(({ terms }) => terms.has(best.anchor)).map(({ entry }) => entry),
  }
}

function scoreEntry(prompt: string, promptTokens: string[], entry: CatalogEntry): CatalogMatch {
  const distinctivePromptTokens = promptTokens.filter((token) => !GENERIC_ROUTING_TOKENS.has(token))
  const reasons: string[] = []
  let score = 0

  if (containsPhrase(prompt, entry.title)) {
    score = 0.96
    reasons.push("catalog title phrase")
  }

  for (const alias of entry.aliases) {
    if (containsPhrase(prompt, alias)) {
      score = Math.max(score, 0.91)
      reasons.push("catalog alias phrase")
    }
  }

  const titleOverlap = overlapRatio(
    tokenize(entry.title).filter((token) => !GENERIC_ROUTING_TOKENS.has(token)),
    distinctivePromptTokens,
  )
  if (titleOverlap > 0) {
    score = Math.max(score, 0.76 * titleOverlap)
    reasons.push("catalog title tokens")
  }

  const aliasOverlap = Math.max(
    0,
    ...entry.aliases.map((alias) =>
      overlapRatio(
        tokenize(alias).filter((token) => !GENERIC_ROUTING_TOKENS.has(token)),
        distinctivePromptTokens,
      ),
    ),
  )
  if (aliasOverlap > 0) {
    score = Math.max(score, 0.7 * aliasOverlap)
    reasons.push("catalog alias tokens")
  }

  const tagOverlap = overlapRatio(
    entry.tags.flatMap(tokenize).filter((token) => !GENERIC_ROUTING_TOKENS.has(token)),
    distinctivePromptTokens,
  )
  if (tagOverlap > 0) {
    score = Math.max(score, 0.52 * tagOverlap)
    reasons.push("catalog tags")
  }

  const summaryTokens = tokenize(entry.summary).filter(
    (token) => !GENERIC_ROUTING_TOKENS.has(token),
  )
  const sharedSummaryTokens = summaryTokens.filter((token) =>
    distinctivePromptTokens.includes(token),
  ).length
  if (sharedSummaryTokens > 0) {
    const summaryScore = 0.2 + Math.min(0.38, sharedSummaryTokens * 0.1)
    score = Math.max(score, summaryScore)
    reasons.push("catalog summary")
  }

  if (STRONG_CONTINUITY.test(prompt) && score > 0) {
    score = clamp(score + (entry.unresolved ? 0.16 : 0.1))
    reasons.push(entry.unresolved ? "continuity and unresolved work" : "continuity phrase")
  }

  return { entry, score, reasons: [...new Set(reasons)] }
}

export class DeterministicRetrievalPlanner {
  constructor(private readonly config: PlannerConfig) {}

  plan(
    prompt: string,
    entries: CatalogEntry[],
    availableProviderIds: string[],
    context?: MemoryContext,
  ): RetrievalPlan {
    const applicability = entries.flatMap((entry) => {
      const institutional = entry.institutional
      if (!institutional || !context) return []
      const reviewStatus = institutionalReviewStatus(institutional)
      if (reviewStatus !== "current") {
        return [
          {
            catalogEntryId: entry.id,
            institutionalId: institutional.id,
            applicable: false,
            reason:
              reviewStatus === "expired"
                ? "institutional review expired"
                : "institutional review is invalid",
          } satisfies ApplicabilityDecision,
        ]
      }
      const applicable = institutionalApplies(institutional, context, prompt)
      const failed = institutional.applicability.conditions.find(
        (condition) => !applicabilityConditionSatisfied(condition, context, prompt),
      )
      return [
        {
          catalogEntryId: entry.id,
          institutionalId: institutional.id,
          applicable,
          reason: applicable
            ? "deterministic applicability conditions passed"
            : `failed deterministic gate ${failed?.id ?? "none"}`,
        } satisfies ApplicabilityDecision,
      ]
    })
    const blocked = new Set(
      applicability
        .filter(({ applicable }) => !applicable)
        .map(({ catalogEntryId }) => catalogEntryId),
    )
    entries = entries.filter((entry) => !blocked.has(entry.id))
    const promptTokens = tokenize(prompt)
    const continuity = STRONG_CONTINUITY.test(prompt)
    const signals = [
      ...(continuity ? ["explicit continuity phrase"] : []),
      ...(blocked.size > 0 ? ["institutional applicability gate blocked catalog entries"] : []),
    ]
    const matches = entries
      .map((entry) => scoreEntry(prompt, promptTokens, entry))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score)

    const qualified = matches.filter((match) => match.score >= this.config.minimumConfidence)
    const fallbackToProviders =
      continuity && qualified.length === 0 && availableProviderIds.length > 0
    const selected = qualified.slice(0, this.config.maxTopics)
    const topics = selected.map((match) => match.entry.title)
    const confidence = selected[0]?.score ?? (fallbackToProviders ? 0.62 : (matches[0]?.score ?? 0))

    const providerReasons = new Map<string, string[]>()
    for (const match of selected) {
      for (const providerId of match.entry.providerIds) {
        if (!availableProviderIds.includes(providerId)) continue
        const reasons = providerReasons.get(providerId) ?? []
        reasons.push(`${match.entry.title}: ${match.reasons.join(", ")}`)
        providerReasons.set(providerId, reasons)
      }
    }
    let anchor: ContinuityAnchor | undefined
    const anchorRoutedProviderIds = new Set<string>()
    if (fallbackToProviders) {
      const candidate = selectContinuityAnchor(promptTokens, entries)
      const routedProviderIds = candidate
        ? availableProviderIds.filter((providerId) =>
            candidate.entries.some((entry) => entry.providerIds.includes(providerId)),
          )
        : []
      if (candidate && routedProviderIds.length > 0) {
        anchor = candidate
        for (const providerId of routedProviderIds) {
          providerReasons.set(providerId, [
            `anchor routing: catalog title/alias token "${candidate.anchor}"`,
          ])
          anchorRoutedProviderIds.add(providerId)
        }
      } else {
        for (const providerId of availableProviderIds) {
          providerReasons.set(providerId, ["continuity phrase with no catalog match"])
        }
      }
    }
    if (anchor) signals.push("anchor-routed continuity fallback")

    const query = prompt.trim().slice(0, 2_000)
    const requests: ProviderRetrievalRequest[] = [...providerReasons].map(
      ([providerId, reasons]) => ({
        providerId,
        query: anchor && anchorRoutedProviderIds.has(providerId) ? anchor.anchor : query,
        reason: reasons.join("; "),
        limit: 8,
        topics: anchorRoutedProviderIds.has(providerId)
          ? (anchor?.entries
              .filter((entry) => entry.providerIds.includes(providerId))
              .map((entry) => entry.title) ?? [])
          : selected
              .filter((match) => match.entry.providerIds.includes(providerId))
              .map((match) => match.entry.title),
      }),
    )

    return {
      shouldRetrieve: requests.length > 0,
      confidence,
      topics,
      requests,
      matches,
      signals,
      applicability,
    }
  }
}
