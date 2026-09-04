import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import remem from "../src/hosts/pi/index.js"
import { deriveHostLocation } from "../src/hosts/pi/location.js"
import { writeAppConfig, type RememAppConfig } from "../src/storage/config-file.js"
import { rememPaths } from "../src/storage/paths.js"
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

function fakeContext(cwd: string, sessionId = "session-test") {
  return { cwd, sessionManager: { getSessionId: () => sessionId } }
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
        preparation: { firstKeptEntryId: "entry-1", tokensBefore: 100 },
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

  it("injects compaction context when config.compaction is enabled", async () => {
    const paths = await installedConfig({ compaction: true })
    vi.stubEnv("REMEM_CONFIG", paths.configFile)

    const pi = new FakeExtensionAPI()
    remem(asExtensionAPI(pi))
    const ctx = fakeContext(fixtureDirectory)
    await pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx)

    const result = (await pi.fire(
      "session_before_compact",
      {
        type: "session_before_compact",
        preparation: { firstKeptEntryId: "entry-1", tokensBefore: 100 },
        branchEntries: [],
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
      },
      ctx,
    )) as { compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number } }

    expect(result.compaction?.firstKeptEntryId).toBe("entry-1")
    expect(result.compaction?.tokensBefore).toBe(100)
    expect(result.compaction?.summary).toContain("Remem continuity")

    await pi.fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx)
  })
})
