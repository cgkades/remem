import { describe, expect, it } from "vitest"
import { RememOrchestrator } from "../src/orchestrator.js"
import { MarkdownMemoryProvider } from "../src/providers/markdown.js"
import type { CapacityLimits, HardLimitWarning } from "../src/capacity.js"
import type {
  CatalogEntry,
  MemoryCapabilities,
  MemoryContext,
  MemoryProvider,
  MemorySearchRequest,
  MemoryResult,
} from "../src/types.js"
import { fixtureDirectory, memoryContext, testConfig } from "./helpers.js"

/**
 * A minimal fake implementing both `MemoryProvider` and `CapacityStore` --
 * TASK-062's orchestrator wiring is provider-shape-agnostic (it only checks
 * `isCapacityStore`), so a fake avoids requiring a live PostgreSQL
 * connection for this unit-level test of the wiring itself. The
 * PostgreSQL-backed implementation of `checkHardLimitWarning` is tested
 * separately (integration tests, disposable database).
 */
class FakeCapacityProvider implements MemoryProvider {
  readonly id: string
  private readonly warning: HardLimitWarning | undefined
  calls = 0

  constructor(id: string, warning: HardLimitWarning | undefined) {
    this.id = id
    this.warning = warning
  }

  capabilities(): MemoryCapabilities {
    return {
      lexicalSearch: false,
      semanticSearch: false,
      metadataFiltering: false,
      catalog: false,
      read: false,
      write: false,
      update: false,
      delete: false,
      episodicHistory: false,
      structuredEntities: false,
      filesystemDocuments: false,
    }
  }

  async catalog(_context: MemoryContext, _signal: AbortSignal): Promise<CatalogEntry[]> {
    return await Promise.resolve([])
  }

  async search(_request: MemorySearchRequest): Promise<MemoryResult[]> {
    return await Promise.resolve([])
  }

  getCapacityStatus(): Promise<never> {
    return Promise.reject(new Error("not used by this test"))
  }

  runCompaction(): Promise<never> {
    return Promise.reject(new Error("not used by this test"))
  }

  enforceHardLimit(): Promise<never> {
    return Promise.reject(new Error("not used by this test"))
  }

  enforceCapacity(): Promise<never> {
    return Promise.reject(new Error("not used by this test"))
  }

  checkHardLimitWarning(
    _providerId: string,
    _projectId: string,
    _options?: { limits?: CapacityLimits; throttleMs?: number },
  ): Promise<HardLimitWarning | undefined> {
    this.calls++
    return Promise.resolve(this.warning)
  }
}

function createOrchestrator(provider: MemoryProvider, recallTokens = 1_400) {
  return createOrchestratorWithProviders([provider], recallTokens)
}

function createOrchestratorWithProviders(providers: MemoryProvider[], recallTokens = 1_400) {
  const config = testConfig({
    budgets: { catalogTokens: 600, recallTokens, perProviderTokens: 900 },
  })
  return new RememOrchestrator(providers, config)
}

describe("TASK-062: session-start hard-limit capacity warning wiring", () => {
  it("injects a bounded, body-free notice at session start (turnId '1') when a provider reports an over-hard-limit warning", async () => {
    const provider = new FakeCapacityProvider("over-hard-provider", {
      totalBytes: 3_000_000_000,
      hardLimitBytes: 2_000_000_000,
    })
    const injection = await createOrchestrator(provider).processPrompt("hello", memoryContext, "1")
    expect(injection.text).toContain("<memory-capacity-notice>")
    expect(injection.text).toContain("over-hard-provider")
    expect(injection.text).toContain("3000000000")
    expect(injection.text).toContain("2000000000")
  })

  it("never includes any evidence content in the notice -- byte counts only", async () => {
    const provider = new FakeCapacityProvider("over-hard-provider", {
      totalBytes: 3_000_000_000,
      hardLimitBytes: 2_000_000_000,
    })
    const injection = await createOrchestrator(provider).processPrompt("hello", memoryContext, "1")
    // The notice must only ever describe the byte/limit numbers -- no
    // markers that would suggest actual stored text leaked into it.
    expect(injection.text).not.toMatch(/safe_text|payload|evidence_refs/)
  })

  it("does not inject a notice when no provider is over the hard limit", async () => {
    const provider = new FakeCapacityProvider("healthy-provider", undefined)
    const injection = await createOrchestrator(provider).processPrompt("hello", memoryContext, "1")
    expect(injection.text).not.toContain("<memory-capacity-notice>")
  })

  it("does not check capacity at all for a turn that is not session start", async () => {
    const provider = new FakeCapacityProvider("over-hard-provider", {
      totalBytes: 3_000_000_000,
      hardLimitBytes: 2_000_000_000,
    })
    const injection = await createOrchestrator(provider).processPrompt("hello", memoryContext, "2")
    expect(injection.text).not.toContain("<memory-capacity-notice>")
    expect(provider.calls).toBe(0)
  })

  it("does not check capacity when no turnId is supplied at all", async () => {
    const provider = new FakeCapacityProvider("over-hard-provider", {
      totalBytes: 3_000_000_000,
      hardLimitBytes: 2_000_000_000,
    })
    const injection = await createOrchestrator(provider).processPrompt("hello", memoryContext)
    expect(injection.text).not.toContain("<memory-capacity-notice>")
    expect(provider.calls).toBe(0)
  })

  it("skips a provider that does not implement CapacityStore, without error", async () => {
    const providerConfig = {
      type: "markdown" as const,
      id: "fixtures",
      paths: [fixtureDirectory],
      exclude: ["**/.git/**"],
      scope: "workspace" as const,
      maxFileBytes: 256 * 1024,
      maxFiles: 100,
    }
    const injection = await createOrchestrator(
      new MarkdownMemoryProvider(providerConfig, [fixtureDirectory]),
    ).processPrompt("hello", memoryContext, "1")
    expect(injection.text).not.toContain("<memory-capacity-notice>")
  })

  it("a capacity check that throws is silently skipped, never breaking the recall pipeline", async () => {
    class ThrowingCapacityProvider extends FakeCapacityProvider {
      override checkHardLimitWarning(): Promise<HardLimitWarning | undefined> {
        throw new Error("capacity backend unavailable")
      }
    }
    const provider = new ThrowingCapacityProvider("flaky-provider", undefined)
    const injection = await createOrchestrator(provider).processPrompt("hello", memoryContext, "1")
    expect(injection.text).not.toContain("<memory-capacity-notice>")
    // The rest of the injection pipeline must still have run normally.
    expect(injection.plan).toBeDefined()
  })

  it("each provider's warning fires independently -- a healthy or throwing provider never suppresses another provider's genuine warning", async () => {
    class ThrowingCapacityProvider extends FakeCapacityProvider {
      override checkHardLimitWarning(): Promise<HardLimitWarning | undefined> {
        throw new Error("capacity backend unavailable")
      }
    }
    const overLimitA = new FakeCapacityProvider("provider-over-limit-a", {
      totalBytes: 2_500_000_000,
      hardLimitBytes: 2_000_000_000,
    })
    const healthyB = new FakeCapacityProvider("provider-healthy-b", undefined)
    const throwingC = new ThrowingCapacityProvider("provider-throwing-c", undefined)
    const overLimitD = new FakeCapacityProvider("provider-over-limit-d", {
      totalBytes: 9_000_000_000,
      hardLimitBytes: 2_000_000_000,
    })

    const injection = await createOrchestratorWithProviders([
      overLimitA,
      healthyB,
      throwingC,
      overLimitD,
    ]).processPrompt("hello", memoryContext, "1")

    expect(injection.text).toContain("provider-over-limit-a")
    expect(injection.text).toContain("provider-over-limit-d")
    expect(injection.text).not.toContain("provider-healthy-b")
    expect(injection.text).not.toContain("provider-throwing-c")
    // Exactly one wrapping block, containing both over-limit providers'
    // lines -- not one block per provider.
    expect(injection.text.match(/<memory-capacity-notice>/g)?.length).toBe(1)
  })
})
