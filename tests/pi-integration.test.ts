import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { configurePi } from "../src/cli/index.js"
import { piIntegrationCheck } from "../src/cli/doctor.js"
import remem, { isCaptureEligibleInputSource, raceAbort } from "../src/hosts/pi/index.js"
import { deriveHostLocation } from "../src/hosts/pi/location.js"
import { writeAppConfig, type RememAppConfig } from "../src/storage/config-file.js"
import { packageRoot, piSettingsPath, rememPaths } from "../src/storage/paths.js"
import { fixtureDirectory } from "./helpers.js"

const roots: string[] = []

async function installedConfig(overrides: Partial<RememAppConfig> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "remem-pi-"))
  roots.push(root)
  const paths = rememPaths({ REMEM_CONFIG_DIR: root, REMEM_DATA_DIR: path.join(root, "data") })
  await mkdir(paths.configDir, { recursive: true })
  const config: RememAppConfig = {
    version: 1,
    storage: { mode: "external", connectionString: "postgres://unused/unused" },
    providers: [
      {
        type: "markdown",
        id: "fixtures",
        paths: [fixtureDirectory],
        exclude: [],
        scope: "workspace",
        maxFileBytes: 256 * 1024,
        maxFiles: 100,
      },
    ],
    embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
    ...overrides,
  }
  await writeAppConfig(config, paths)
  return paths
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Minimal fake matching the subset of `ExtensionAPI`/`ExtensionContext` the Pi adapter uses. */
class FakeExtensionAPI {
  readonly handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  readonly tools = new Map<string, { execute: (...args: unknown[]) => unknown }>()

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    this.handlers.set(event, handler)
  }

  registerTool(tool: { name: string; execute: (...args: unknown[]) => unknown }): void {
    this.tools.set(tool.name, tool)
  }

  fire(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    const handler = this.handlers.get(event)
    if (!handler) throw new Error(`no handler registered for ${event}`)
    return Promise.resolve(handler(payload, ctx))
  }
}

function fakeContext(
  cwd: string,
  options: {
    sessionId?: string
    model?: unknown
    complete?: (model: unknown, context: unknown, completeOptions: unknown) => Promise<unknown>
  } = {},
) {
  const sessionId = options.sessionId ?? "session-test"
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    model: options.model,
    modelRegistry: {
      complete:
        options.complete ??
        (() => Promise.reject(new Error("fakeContext: no model configured for this test"))),
    },
  }
}

async function writeAppConfigLikeSettings(settingsPath: string, value: unknown): Promise<void> {
  await writeFile(settingsPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

/** Test-only cast: `FakeExtensionAPI` implements only the subset of `ExtensionAPI` the Pi adapter uses. */
function asExtensionAPI(pi: FakeExtensionAPI): ExtensionAPI {
  return pi as unknown as ExtensionAPI
}

describe("Pi host location derivation", () => {
  it("derives a stable projectId for the same worktree across calls", async () => {
    const first = await deriveHostLocation(fixtureDirectory)
    const second = await deriveHostLocation(fixtureDirectory)
    expect(first.projectId).toBe(second.projectId)
    expect(first.projectId).toMatch(/^[0-9a-f]{32}$/u)
    expect(first.directory).toBe(path.resolve(fixtureDirectory))
  })

  it("falls back to a cwd hash outside a git repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-pi-nongit-"))
    roots.push(root)
    const location = await deriveHostLocation(root)
    expect(location.worktree).toBe(path.resolve(root))
    expect(location.projectId).toMatch(/^[0-9a-f]{32}$/u)
  })
})

describe("Pi host extension", () => {
  it("injects bounded, attributed Remem context on before_agent_start", async () => {
    const paths = await installedConfig()
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory)
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = (await pi.fire(
      "before_agent_start",
      { type: "before_agent_start", prompt: "Let's continue the Phoenix database work." },
      ctx,
    )) as { message?: { content: Array<{ type: "text"; text: string }> } } | undefined

    expect(result?.message).toBeDefined()
    const text = result?.message?.content.map((part) => part.text).join("\n") ?? ""
    expect(text).toContain("untrusted evidence")
    expect(text).toContain("use logical replication")

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("degrades to a no-op before session_start has run", async () => {
    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory)

    await expect(
      pi.fire("before_agent_start", { type: "before_agent_start", prompt: "anything" }, ctx),
    ).resolves.toBeUndefined()

    await expect(
      pi.fire("input", { type: "input", text: "anything", source: "interactive" }, ctx),
    ).resolves.toBeUndefined()
  })

  it("registers memory_search, memory_status, and memory_explain tools", async () => {
    const paths = await installedConfig()
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory)
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    expect([...pi.tools.keys()].sort()).toEqual([
      "memory_explain",
      "memory_search",
      "memory_status",
    ])

    const search = pi.tools.get("memory_search")
    const searchResult = (await search?.execute(
      "call-1",
      { query: "Phoenix database" },
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ type: "text"; text: string }> }
    expect(searchResult.content[0]?.text).toContain("use logical replication")

    const status = pi.tools.get("memory_status")
    const statusResult = (await status?.execute("call-2", {}, undefined, undefined, ctx)) as
      { content: Array<{ type: "text"; text: string }> } | undefined
    const statusText = statusResult?.content[0]?.text ?? ""
    expect(() => JSON.parse(statusText) as unknown).not.toThrow()

    const explain = pi.tools.get("memory_explain")
    const explainResult = (await explain?.execute("call-3", {}, undefined, undefined, ctx)) as
      { content: Array<{ type: "text"; text: string }> } | undefined
    expect(explainResult?.content[0]?.text).toBeDefined()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("tools degrade gracefully before session_start has run", async () => {
    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory)

    const search = pi.tools.get("memory_search")
    const result = (await search?.execute(
      "call-1",
      { query: "anything" },
      undefined,
      undefined,
      ctx,
    )) as { content: Array<{ type: "text"; text: string }> }
    expect(result.content[0]?.text).toContain("Pi can continue without memory")
  })

  it("never throws from the input hook when capture is disabled (default)", async () => {
    const paths = await installedConfig()
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory)
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    await expect(
      pi.fire(
        "input",
        { type: "input", text: "Actually, always use tabs.", source: "interactive" },
        ctx,
      ),
    ).resolves.toBeUndefined()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("never enqueues capture for extension- or rpc-sourced input, only interactive", () => {
    expect(isCaptureEligibleInputSource("interactive")).toBe(true)
    expect(isCaptureEligibleInputSource("extension")).toBe(false)
    expect(isCaptureEligibleInputSource("rpc")).toBe(false)
  })

  it("does not throw for extension-sourced input carrying preference/decision-shaped text", async () => {
    const paths = await installedConfig()
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory)
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    // Text shaped like an explicit user preference/decision, but attributed
    // to another extension via sendUserMessage rather than a human typing.
    // The regression this guards: such text must never reach
    // CaptureCoordinator.enqueue (isCaptureEligibleInputSource above is the
    // gate the "input" handler must apply before calling it).
    await expect(
      pi.fire(
        "input",
        {
          type: "input",
          text: "We decided: always use tabs. This is a permanent policy.",
          source: "extension",
        },
        ctx,
      ),
    ).resolves.toBeUndefined()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("skips compaction-context injection unless config.compaction is enabled", async () => {
    const paths = await installedConfig({ compaction: false })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory)
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = await pi.fire(
      "session_before_compact",
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-1",
          tokensBefore: 100,
          messagesToSummarize: [],
          turnPrefixMessages: [],
        },
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctx,
    )
    expect(result).toBeUndefined()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("does not customize tree navigation unless the user requests a summary", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const complete = vi.fn(() => Promise.reject(new Error("must not be called")))
    const ctx = fakeContext(fixtureDirectory, { model: { id: "fake-model" }, complete })
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = await pi.fire(
      "session_before_tree",
      {
        type: "session_before_tree",
        preparation: { userWantsSummary: false, entriesToSummarize: [] },
        signal: new AbortController().signal,
      },
      ctx,
    )
    expect(result).toBeUndefined()
    expect(complete).not.toHaveBeenCalled()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("falls back to Pi's default branch summary when no model is configured", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory)
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = await pi.fire(
      "session_before_tree",
      {
        type: "session_before_tree",
        preparation: { userWantsSummary: true, entriesToSummarize: [] },
        signal: new AbortController().signal,
      },
      ctx,
    )
    expect(result).toBeUndefined()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("summarizes an abandoned branch and appends Remem continuity when a model is available", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const entriesToSummarize = [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "Investigate the billing schema migration." }],
        },
      },
    ]
    let receivedContext: { messages: Array<{ content: Array<{ text: string }> }> } | undefined
    const complete = (_model: unknown, context: unknown) => {
      receivedContext = context as typeof receivedContext & object
      return Promise.resolve({
        content: [{ type: "text", text: "## Progress\nInvestigated the billing schema." }],
        usage: { input: 10, output: 5 },
      })
    }
    const ctx = fakeContext(fixtureDirectory, { model: { id: "fake-model" }, complete })
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = (await pi.fire(
      "session_before_tree",
      {
        type: "session_before_tree",
        preparation: {
          userWantsSummary: true,
          entriesToSummarize,
          customInstructions: "Focus on migration safety.",
        },
        signal: new AbortController().signal,
      },
      ctx,
    )) as { summary?: { summary: string; usage?: unknown } }

    expect(JSON.stringify(receivedContext)).toContain("Investigate the billing schema migration")
    expect(JSON.stringify(receivedContext)).toContain("Focus on migration safety.")
    expect(result.summary?.summary).toContain("Investigated the billing schema.")
    expect(result.summary?.summary).toContain("Remem continuity")
    expect(result.summary?.usage).toEqual({ input: 10, output: 5 })

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("includes custom_message entries (e.g. another extension's injected context) in the abandoned-branch summary", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const entriesToSummarize = [
      {
        type: "custom_message",
        id: "entry-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "some-other-extension",
        content: [{ type: "text", text: "Injected context: use the staging database." }],
        display: false,
      },
    ]
    let receivedContext: unknown
    const complete = (_model: unknown, context: unknown) => {
      receivedContext = context
      return Promise.resolve({
        content: [{ type: "text", text: "## Progress\nNoted the staging database context." }],
        usage: { input: 10, output: 5 },
      })
    }
    const ctx = fakeContext(fixtureDirectory, { model: { id: "fake-model" }, complete })
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = (await pi.fire(
      "session_before_tree",
      {
        type: "session_before_tree",
        preparation: { userWantsSummary: true, entriesToSummarize },
        signal: new AbortController().signal,
      },
      ctx,
    )) as { summary?: { summary: string } }

    expect(JSON.stringify(receivedContext)).toContain("use the staging database")
    expect(result.summary?.summary).toContain("Noted the staging database context.")

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("stops waiting on Remem continuity once tree navigation is aborted, without calling the model", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const entriesToSummarize = [
      {
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: "Investigate something." }] },
      },
    ]
    const complete = vi.fn(() => Promise.reject(new Error("must not be called")))
    const ctx = fakeContext(fixtureDirectory, { model: { id: "fake-model" }, complete })
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    // A never-resolving continuity fetch stands in for a slow/hung memory
    // provider: the handler must not hang waiting on it once the caller's
    // signal aborts, and must never reach the model call afterward. Aborting
    // synchronously right after firing relies on the handler having already
    // attached its abort listener before yielding at its first `await`.
    const controller = new AbortController()
    const firePromise = pi.fire(
      "session_before_tree",
      {
        type: "session_before_tree",
        preparation: { userWantsSummary: true, entriesToSummarize },
        signal: controller.signal,
      },
      ctx,
    )
    controller.abort()
    await expect(firePromise).resolves.toBeUndefined()
    expect(complete).not.toHaveBeenCalled()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("raceAbort never produces an unhandled rejection when the input promise is already aborted and later rejects", async () => {
    const rejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onUnhandledRejection)
    try {
      const controller2 = new AbortController()
      controller2.abort()
      let reject!: (reason?: unknown) => void
      const promise = new Promise<string>((_resolve, rej) => {
        reject = rej
      })

      const result = raceAbort(promise, controller2.signal)
      reject(new Error("simulated compactionContext failure"))
      await expect(result).resolves.toBeUndefined()

      // Flush enough of the event loop for Node to have raised
      // unhandledRejection if `promise`'s rejection went unconsumed.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
    }
    expect(rejections).toEqual([])
  })

  it("falls back to Pi's default branch summary when the summarizer call fails", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory, {
      model: { id: "fake-model" },
      complete: () => Promise.reject(new Error("model unavailable")),
    })
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = await pi.fire(
      "session_before_tree",
      {
        type: "session_before_tree",
        preparation: { userWantsSummary: true, entriesToSummarize: [] },
        signal: new AbortController().signal,
      },
      ctx,
    )
    expect(result).toBeUndefined()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("skips branch-summary work when there are no abandoned entries", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const complete = vi.fn(() => Promise.reject(new Error("must not be called")))
    const ctx = fakeContext(fixtureDirectory, { model: { id: "fake-model" }, complete })
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    await expect(
      pi.fire(
        "session_before_tree",
        {
          type: "session_before_tree",
          preparation: { userWantsSummary: true, entriesToSummarize: [] },
          signal: new AbortController().signal,
        },
        ctx,
      ),
    ).resolves.toBeUndefined()
    expect(complete).not.toHaveBeenCalled()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("falls back to Pi's default compaction when no model is configured, never discarding history", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    // No `model`/`complete` supplied: fakeContext's default `complete` rejects,
    // but the handler must check `ctx.model` first and bail out to `undefined`
    // (Pi's own default compactor) without ever calling it.
    const ctx = fakeContext(fixtureDirectory)
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = await pi.fire(
      "session_before_compact",
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-1",
          tokensBefore: 100,
          messagesToSummarize: [],
          turnPrefixMessages: [],
        },
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctx,
    )
    expect(result).toBeUndefined()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("summarizes the actual conversation and appends Remem continuity when a model is available", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))

    const messagesToSummarize = [
      {
        role: "user",
        content: [{ type: "text", text: "Migrate the billing service to the new schema." }],
      },
    ]
    let receivedContext: { messages: Array<{ content: Array<{ text: string }> }> } | undefined
    const complete = (_model: unknown, context: unknown) => {
      receivedContext = context as typeof receivedContext & object
      return Promise.resolve({
        content: [{ type: "text", text: "## Goal\nMigrate the billing service." }],
        usage: { input: 10, output: 5 },
      })
    }
    const ctx = fakeContext(fixtureDirectory, { model: { id: "fake-model" }, complete })
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = (await pi.fire(
      "session_before_compact",
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-1",
          tokensBefore: 100,
          messagesToSummarize,
          turnPrefixMessages: [],
        },
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctx,
    )) as {
      compaction?: {
        summary: string
        firstKeptEntryId: string
        tokensBefore: number
        usage?: unknown
      }
    }

    // The real conversation content reached the summarizer call...
    const sentText = JSON.stringify(receivedContext)
    expect(sentText).toContain("Migrate the billing service to the new schema")
    // ...and the actual generated summary -- not just Remem continuity -- is
    // what gets returned as the compaction result, with continuity appended
    // rather than substituted.
    expect(result.compaction?.summary).toContain("Migrate the billing service.")
    expect(result.compaction?.summary).toContain("Remem continuity")
    expect(result.compaction?.firstKeptEntryId).toBe("entry-1")
    expect(result.compaction?.tokensBefore).toBe(100)
    expect(result.compaction?.usage).toEqual({ input: 10, output: 5 })

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })

  it("falls back to Pi's default compaction when the summarizer call fails", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory, {
      model: { id: "fake-model" },
      complete: () => Promise.reject(new Error("model unavailable")),
    })
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = await pi.fire(
      "session_before_compact",
      {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: "entry-1",
          tokensBefore: 100,
          messagesToSummarize: [],
          turnPrefixMessages: [],
        },
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctx,
    )
    expect(result).toBeUndefined()

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })
})

describe("Pi CLI and doctor wiring", () => {
  it("packageRoot resolves two directories up from the caller (its real src/cli/* call-site depth)", () => {
    const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
    const syntheticCallSite = new URL("../src/cli/probe.ts", import.meta.url)
    expect(packageRoot(syntheticCallSite.toString())).toBe(repoRoot)
  })

  it("piSettingsPath respects PI_CODING_AGENT_DIR and defaults to ~/.pi/agent", () => {
    const overridden = piSettingsPath({ PI_CODING_AGENT_DIR: "/custom/pi-dir" })
    expect(overridden).toBe(path.join("/custom/pi-dir", "settings.json"))

    const defaulted = piSettingsPath({})
    expect(defaulted).toBe(path.join(os.homedir(), ".pi", "agent", "settings.json"))
  })

  it("configurePi adds this package's root to packages, additively and idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-pi-settings-"))
    roots.push(root)
    const settingsPath = path.join(root, "settings.json")
    const expectedRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)))

    await configurePi(settingsPath)
    const first = JSON.parse(await readFile(settingsPath, "utf8")) as { packages: unknown[] }
    expect(first.packages).toEqual([expectedRoot])

    // Re-running must not duplicate the entry or drop unrelated settings.
    const withUnrelatedSetting = {
      ...first,
      defaultProjectTrust: "ask",
    }
    await writeAppConfigLikeSettings(settingsPath, withUnrelatedSetting)
    await configurePi(settingsPath)
    const second = JSON.parse(await readFile(settingsPath, "utf8")) as {
      packages: unknown[]
      defaultProjectTrust: string
    }
    expect(second.packages).toEqual([expectedRoot])
    expect(second.defaultProjectTrust).toBe("ask")
  })

  it("piIntegrationCheck reports ok only when this package's root is present, even with backslash-heavy paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-pi-doctor-"))
    roots.push(root)
    const settingsPath = path.join(root, "settings.json")

    const missing = await piIntegrationCheck(settingsPath)
    expect(missing.status).toBe("warn")

    await configurePi(settingsPath)
    const configured = await piIntegrationCheck(settingsPath)
    expect(configured.status).toBe("ok")
    expect(configured.detail).toContain(settingsPath)

    // Regression coverage for the Windows JSON-escaping bug: a settings file
    // whose `packages` array contains a backslash-heavy (Windows-style) path
    // must still be recognized via array membership, not a raw substring
    // match against the JSON-escaped file text.
    const windowsStylePath = "C:\\Users\\example\\opencode-remem"
    await writeAppConfigLikeSettings(settingsPath, { packages: [windowsStylePath] })
    const windowsStyle = await piIntegrationCheck(settingsPath)
    const written = JSON.parse(await readFile(settingsPath, "utf8")) as { packages: unknown[] }
    expect(written.packages).toContain(windowsStylePath)
    expect(windowsStyle.status).toBe("warn")
  })

  it("piIntegrationCheck fails open on malformed settings JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "remem-pi-doctor-malformed-"))
    roots.push(root)
    const settingsPath = path.join(root, "settings.json")
    await writeFile(settingsPath, "{not-json")

    const result = await piIntegrationCheck(settingsPath)
    expect(result.status).toBe("warn")
  })
})
