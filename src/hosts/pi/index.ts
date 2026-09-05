import { randomUUID } from "node:crypto"
import type { ExtensionAPI, ExtensionContext, InputSource } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { createCaptureCoordinator, type CaptureCoordinator } from "../../capture.js"
import { parseConfig, type RememConfig } from "../../config.js"
import { RememOrchestrator } from "../../orchestrator.js"
import { PostgresMemoryProvider } from "../../providers/postgres.js"
import { createProviders } from "../../providers/factory.js"
import { shouldAttemptReembed } from "../../reembedding.js"
import { loadInstalledPluginOptions } from "../../storage/config-file.js"
import { createEmbeddingModel } from "../../storage/embedding-neural.js"
import type { MemoryProvider, RememLogger } from "../../types.js"
import {
  TRUSTED_REMEM_INSTRUCTION,
  disposeProviders,
  memoryContext,
  recallForDispatch,
  safeLoggerCall,
  type HostLocation,
} from "../opencode/shared.js"
import { deriveHostLocation } from "./location.js"

/**
 * Session-scoped state built on `session_start` and torn down on
 * `session_shutdown`. Pi's `pi.on(...)` registrations are not
 * session-scoped (they run for the life of the extension module), so every
 * handler below reads through this closure-held state and no-ops when it is
 * unset -- either before the first `session_start` or after
 * `session_shutdown` has already run for the current session.
 */
interface PiSessionState {
  location: HostLocation
  config: Pick<RememConfig, "compaction" | "reembedCooldownMs">
  orchestrator: RememOrchestrator
  providers: MemoryProvider[]
  capture?: CaptureCoordinator | undefined
  primaryPostgres?: PostgresMemoryProvider | undefined
  lastReembedAttempt?: number | undefined
}

/**
 * Whether Pi input from `source` may be treated as an explicit user
 * statement eligible for `CaptureCoordinator` (opt-in capture of
 * corrections/preferences/decisions into durable review candidates).
 *
 * Only `"interactive"` (a human typing) qualifies. `"extension"` input is
 * synthesized by another extension via `sendUserMessage` -- if it were
 * captured, that extension could get its own generated text durably
 * recorded as though a human had explicitly stated it, which would let
 * generated content authorize its own persistence (the same class of
 * problem `containsSensitiveCredential`/synthetic-text filtering in
 * `src/capture.ts` already guards against for *content*, not provenance).
 * `"rpc"` (API-driven, not necessarily a human at a keyboard) is
 * conservatively treated the same way until a reviewed trust policy exists
 * for it; this can be relaxed later, but only for `"rpc"` explicitly, not
 * `"extension"`.
 */
export function isCaptureEligibleInputSource(source: InputSource): boolean {
  return source === "interactive"
}

/**
 * Minimal, dependency-free rendering of Pi `AgentMessage[]` into plain text
 * for our own summarization prompt. Deliberately does not import Pi's own
 * `convertToLlm`/`serializeConversation` helpers: those are only reachable
 * through `@earendil-works/pi-coding-agent`'s top-level entry, which (as of
 * 0.85.0) transitively imports `@earendil-works/pi-server` via
 * `dist/experimental/server.js` without declaring it as a dependency --
 * that import can fail to resolve depending on how a consumer's `npm
 * install` happens to hoist packages. This rendering does not need to match
 * Pi's internal format exactly; it only needs to give the summarizer model
 * enough plain text to work with.
 */
function renderMessagesForSummary(messages: readonly unknown[]): string {
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return ""
      const role = "role" in message ? String(message.role) : "unknown"
      const content = "content" in message ? message.content : undefined
      const text = Array.isArray(content)
        ? content
            .map((part): string => {
              if (!part || typeof part !== "object") return ""
              if ("text" in part && typeof (part as { text: unknown }).text === "string") {
                return (part as { text: string }).text
              }
              if ("type" in part && (part as { type: unknown }).type === "toolCall") {
                const name = "name" in part ? String((part as { name: unknown }).name) : "tool"
                return `[tool call: ${name}]`
              }
              return ""
            })
            .filter((part) => part.length > 0)
            .join("\n")
        : typeof content === "string"
          ? content
          : ""
      return `[${role}]: ${text}`
    })
    .filter((line) => line.trim().length > 4)
    .join("\n")
}

/**
 * Tokens reserved when bounding rendered branch history before
 * summarization, mirroring Pi's own default `reserveTokens` for
 * compaction/branch-summary budgeting (`docs/compaction.md`'s
 * `reserveTokens` setting, default 16384). Named here so both this reserve
 * and its rationale stay in one place if it needs tuning later, rather than
 * being an inline magic number at the call site.
 */
const BRANCH_SUMMARY_RESERVE_TOKENS = 16_384

/**
 * Pi's tree hook supplies session entries, while compaction supplies agent
 * messages. Keep the tree conversion local: Pi only exports its conversion
 * helpers through its top-level runtime entry, which may load an undeclared
 * server dependency in consumers (see `renderMessagesForSummary`).
 */
function branchMessagesForSummary(entries: readonly unknown[], tokenBudget: number): unknown[] {
  const messages: unknown[] = []
  let tokens = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || typeof entry !== "object" || !("type" in entry)) continue
    const type = entry.type
    const message =
      type === "message" && "message" in entry
        ? entry.message
        : type === "custom_message" && "content" in entry
          ? {
              role: `custom:${"customType" in entry ? String(entry.customType) : "message"}`,
              content: entry.content,
            }
          : (type === "compaction" || type === "branch_summary") &&
              "summary" in entry &&
              typeof entry.summary === "string"
            ? // Synthetic, rendering-only role: `renderMessagesForSummary` only
              // reads `role`/`content` for display in the summarizer prompt, so
              // this never needs to match a real Pi/LLM message role -- it just
              // needs to label prior compaction/branch-summary text distinctly
              // from ordinary conversation turns.
              { role: "summary", content: entry.summary }
            : undefined
    if (!message) continue
    // Pi's own branch preparation retains the newest messages that fit its
    // context budget. This conservative estimate avoids an unbounded request
    // without importing Pi's runtime-only token helpers. Dividing by 3
    // (rather than a more typical ~4 chars/token) intentionally overestimates
    // for code-heavy/symbol-dense conversation content so the request stays
    // safely within the model's real context window.
    const estimatedTokens = Math.ceil(JSON.stringify(message).length / 3)
    if (tokens + estimatedTokens > tokenBudget) break
    messages.unshift(message)
    tokens += estimatedTokens
  }
  return messages
}

/**
 * Resolve `promise`, but resolve to `undefined` early if `signal` aborts
 * first. Does not cancel `promise`'s underlying work (Remem's
 * `compactionContext` has no cancellation parameter) -- it only stops the
 * caller from waiting on and acting on a result that arrives after the
 * caller no longer wants it.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(undefined)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

function piLogger(): RememLogger {
  return {
    log(level, event, data) {
      if (level === "debug" || level === "info") return
      const detail = data ? ` ${JSON.stringify(data)}` : ""
      console.error(`[remem] ${event}${detail}`)
    },
  }
}

function contextFor(state: PiSessionState, ctx: Pick<ExtensionContext, "sessionManager">) {
  return memoryContext(state.location, ctx.sessionManager.getSessionId())
}

async function buildSessionState(
  ctx: ExtensionContext,
  logger: RememLogger,
): Promise<PiSessionState | undefined> {
  try {
    const parsed = parseConfig(await loadInstalledPluginOptions(undefined))
    for (const diagnostic of parsed.diagnostics) {
      safeLoggerCall(logger, diagnostic.level, "config.invalid", { message: diagnostic.message })
    }
    const location = await deriveHostLocation(ctx.cwd)
    const embeddingModel = await createEmbeddingModel(parsed.config.embedding)
    const created = createProviders(
      parsed.config.providers,
      { worktree: location.worktree },
      { embeddingModel },
    )
    for (const diagnostic of created.diagnostics) {
      safeLoggerCall(logger, "warn", "provider.initialization_failed", { message: diagnostic })
    }
    const primaryPostgres = created.providers.find(
      (provider): provider is PostgresMemoryProvider => provider instanceof PostgresMemoryProvider,
    )
    const orchestrator = new RememOrchestrator(created.providers, parsed.config, logger, {
      embeddingModel,
    })
    const capture = createCaptureCoordinator(created.providers, parsed.config, logger)
    return {
      location,
      config: parsed.config,
      orchestrator,
      providers: created.providers,
      capture,
      primaryPostgres,
    }
  } catch (error) {
    safeLoggerCall(logger, "error", "extension.initialization_failed", {
      error: error instanceof Error ? error.name : "unknown error",
    })
    return undefined
  }
}

async function teardownSessionState(state: PiSessionState | undefined): Promise<void> {
  if (!state) return
  await Promise.allSettled([state.capture?.dispose(), disposeProviders(state.providers)])
}

function registerTools(pi: ExtensionAPI, getState: () => PiSessionState | undefined): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search configured long-term memory providers explicitly. Use when automatic recall was insufficient.",
    promptSnippet: "Explicitly search Remem's long-term memory providers",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Specific memory query" }),
      provider: Type.Optional(Type.String({ minLength: 1, description: "Optional provider ID" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const state = getState()
      if (!state) {
        return {
          content: [
            { type: "text", text: "Memory search failed. Pi can continue without memory." },
          ],
          details: {},
        }
      }
      try {
        const result = await state.orchestrator.search(
          params.query,
          contextFor(state, ctx),
          params.provider,
          signal,
        )
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            providers: result.trace.providers.map((provider) => provider.providerId),
            selectedResults: result.trace.selectedResults,
            estimatedTokens: result.trace.recallTokens,
          },
        }
      } catch (error) {
        if (signal?.aborted) throw error
        return {
          content: [
            { type: "text", text: "Memory search failed. Pi can continue without memory." },
          ],
          details: {},
        }
      }
    },
  })

  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description: "Show memory health and bounded diagnostics without memory bodies.",
    promptSnippet: "Show Remem's memory health and diagnostics",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getState()
      if (!state) {
        return {
          content: [
            { type: "text", text: "Memory status unavailable: extension not initialized." },
          ],
          details: {},
        }
      }
      try {
        const status = await state.orchestrator.status(contextFor(state, ctx))
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], details: {} }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Memory status unavailable: ${error instanceof Error ? error.name : "unknown error"}`,
            },
          ],
          details: {},
        }
      }
    },
  })

  pi.registerTool({
    name: "memory_explain",
    label: "Memory Explain",
    description: "Explain the latest memory retrieval decision without exposing memory bodies.",
    promptSnippet: "Explain Remem's latest memory retrieval decision",
    parameters: Type.Object({}),
    execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const state = getState()
      if (!state) {
        return Promise.resolve({
          content: [{ type: "text", text: JSON.stringify({ status: "no-trace" }, null, 2) }],
          details: {},
        })
      }
      const trace = state.orchestrator.explain(ctx.sessionManager.getSessionId())
      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(trace, null, 2) }],
        details: {},
      })
    },
  })
}

/**
 * Pi extension entry point (`export default function(pi: ExtensionAPI)`).
 * Mirrors the memory-injection, tool, capture, and (optional)
 * compaction-context behavior of the OpenCode v1/v2 adapters
 * (`src/hosts/opencode/v1.ts`, `src/hosts/opencode/v2.ts`), mapped onto
 * Pi's `before_agent_start` / `pi.registerTool` / `input` /
 * `session_before_compact` / `session_before_tree` events instead of OpenCode's plugin hooks.
 */
export default function remem(pi: ExtensionAPI): void {
  const logger = piLogger()
  let state: PiSessionState | undefined

  pi.on("session_start", async (_event, ctx) => {
    state = await buildSessionState(ctx, logger)
  })

  pi.on("session_shutdown", async () => {
    const disposing = state
    state = undefined
    await teardownSessionState(disposing)
  })

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state) return
    try {
      const injection = await recallForDispatch(
        state.orchestrator,
        event.prompt,
        contextFor(state, ctx),
      )
      if (!injection.text) return
      return {
        message: {
          customType: "remem-memory",
          content: [
            { type: "text", text: TRUSTED_REMEM_INSTRUCTION },
            {
              type: "text",
              // Untrusted-memory-data attribution is carried in the text itself
              // (Pi's TextContent has no metadata field, unlike OpenCode's
              // message content parts) so the trust boundary survives even if
              // this message is later rendered or logged without its
              // customType/details context.
              text: `<memory-context source="remem" trust="untrusted-memory-data">\n${injection.text}\n</memory-context>`,
            },
          ],
          display: false,
        },
      }
    } catch (error) {
      safeLoggerCall(logger, "warn", "prompt.injection_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      })
      return undefined
    }
  })

  pi.on("input", (event, ctx) => {
    if (!state) return
    const sessionId = ctx.sessionManager.getSessionId()
    if (isCaptureEligibleInputSource(event.source)) {
      try {
        state.capture?.enqueue({
          host: "pi",
          context: contextFor(state, ctx),
          sessionId,
          text: event.text,
        })
      } catch (error) {
        safeLoggerCall(logger, "warn", "capture.enqueue_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        })
      }
    }
    const primaryPostgres = state.primaryPostgres
    if (
      primaryPostgres &&
      shouldAttemptReembed(state.lastReembedAttempt, Date.now, state.config.reembedCooldownMs)
    ) {
      state.lastReembedAttempt = Date.now()
      // Fire-and-forget: must never delay or fail input handling. Reembedding
      // is opportunistic maintenance, not an assertion about the input's
      // provenance, so it runs regardless of `event.source`.
      void primaryPostgres.reembedStale().catch((error) => {
        safeLoggerCall(logger, "warn", "reembed.attempt_failed", {
          error: error instanceof Error ? error.name : "unknown error",
        })
      })
    }
  })

  pi.on("session_before_tree", async (event, ctx) => {
    if (!state || !state.config.compaction || !event.preparation.userWantsSummary) return
    const { preparation, signal } = event
    if (preparation.entriesToSummarize.length === 0) return
    const model = ctx.model
    // Pi's `summary` return value fully replaces its branch summary. Do not
    // replace abandoned-branch history with Remem-only continuity: if no real
    // summary can be made, return undefined and let Pi use its default flow.
    if (!model) return undefined
    try {
      const messages = branchMessagesForSummary(
        preparation.entriesToSummarize,
        Math.max(0, model.contextWindow - BRANCH_SUMMARY_RESERVE_TOKENS),
      )
      if (messages.length === 0) return undefined
      const conversationText = renderMessagesForSummary(messages)
      const continuity = await raceAbort(
        state.orchestrator.compactionContext(contextFor(state, ctx)),
        signal,
      )
      if (signal.aborted || continuity === undefined) return undefined
      const customInstructions = preparation.customInstructions
      const instructions =
        preparation.replaceInstructions && customInstructions
          ? customInstructions
          : [
              "You are a conversation summarizer. Create a comprehensive summary of this",
              "abandoned conversation branch that captures goals, decisions, technical",
              "details, current state, blockers, and next steps. Format as structured",
              "markdown. This summary provides the context from the branch being left, so",
              "include everything needed to continue or revisit that work.",
              customInstructions ? `\nAdditional focus: ${customInstructions}` : "",
            ].join("\n")
      const response = await ctx.modelRegistry.complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    instructions,
                    "",
                    "<conversation>",
                    conversationText,
                    "</conversation>",
                  ].join("\n"),
                },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: 8192, signal, cacheRetention: "none", sessionId: randomUUID() },
      )
      const summaryText = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
      if (signal.aborted || response.stopReason === "aborted" || response.stopReason === "error") {
        return undefined
      }
      if (!summaryText) return undefined
      return {
        summary: {
          // Continuity augments the real branch summary; it never replaces it.
          summary: [summaryText, "", continuity].join("\n"),
          usage: response.usage,
        },
      }
    } catch (error) {
      safeLoggerCall(logger, "warn", "branch_summary.context_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      })
      return undefined
    }
  })

  pi.on("session_before_compact", async (event, ctx) => {
    if (!state || !state.config.compaction) return
    const { preparation, signal } = event
    const model = ctx.model
    // `{ compaction: {...} }` fully REPLACES Pi's own compaction summary --
    // it is not additive the way OpenCode v1's `experimental.session
    // .compacting` context-push is. Returning Remem-only continuity text
    // here (as an earlier version of this adapter did) would silently
    // discard the actual conversation history being compacted. Without a
    // model to generate a real summary, fall back to Pi's default compactor
    // entirely rather than risk that loss.
    if (!model) return undefined
    try {
      const allMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
      const conversationText = renderMessagesForSummary(allMessages)
      const continuity = await state.orchestrator.compactionContext(contextFor(state, ctx))
      const previousContext = preparation.previousSummary
        ? `\n\nPrevious session summary for context:\n${preparation.previousSummary}`
        : ""
      const response = await ctx.modelRegistry.complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: [
                    "You are a conversation summarizer. Create a comprehensive summary of this",
                    "conversation that captures goals, decisions, technical details, current",
                    "state, blockers, and next steps. Format as structured markdown. This",
                    "summary REPLACES the summarized conversation history, so include",
                    "everything needed to continue the work.",
                    previousContext,
                    "",
                    "<conversation>",
                    conversationText,
                    "</conversation>",
                  ].join("\n"),
                },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        { maxTokens: 8192, signal, cacheRetention: "none", sessionId: randomUUID() },
      )
      const summaryText = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim()
      // Empty summary or any failure below falls back to Pi's default
      // compactor (return undefined) rather than losing history.
      if (!summaryText) return undefined
      return {
        compaction: {
          // Remem continuity is appended to the real conversation summary,
          // not substituted for it -- see the comment above.
          summary: [summaryText, "", continuity].join("\n"),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
        },
      }
    } catch (error) {
      safeLoggerCall(logger, "warn", "compaction.context_failed", {
        error: error instanceof Error ? error.name : "unknown error",
      })
      return undefined
    }
  })

  registerTools(pi, () => state)
}
