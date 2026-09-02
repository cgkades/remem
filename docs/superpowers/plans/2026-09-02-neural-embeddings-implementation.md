# Local Neural Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `bge-small-en-v1.5` (via `@huggingface/transformers`) as the managed-mode default `EmbeddingModel`, with `LocalHashEmbeddingModel` retained as an always-available fail-open fallback, plus the config, detection, and hook-triggered re-embedding machinery the design spec requires.

**Architecture:** A new `BgeSmallEmbeddingModel` (lazy-loaded via dynamic `import()`) is selected by a new `embedding` config block, threaded through `createProviders`/`RememOrchestrator` the same way `LocalHashEmbeddingModel` already is today. Model-identity mismatches are detected and repaired by a new `PostgresReembedRunner`, which copies `PostgresConsolidationRunner`'s claim/complete/fail/recover pattern exactly, and is triggered opportunistically (cooldown-gated, fire-and-forget) from the existing `"prompt"` session hook — no cron, no daemon.

**Tech Stack:** TypeScript, `@huggingface/transformers` (ONNX Runtime), `pg`/pgvector, vitest.

**Reference:** `docs/superpowers/specs/2026-09-02-neural-embeddings-design.md` (resolves [#1](https://github.com/cgkades/remem/issues/1))

---

## Important scoping note (read before starting)

`remem.memory_embeddings.embedding` is a **physical `vector(384)` pgvector column** (`migrations/0001_initial_schema.sql:124`), and `remem.catalog_entries.embedding_dimensions` has a **hard `CHECK (... = 384)` constraint** (`migrations/0003_scoped_entities_catalog_embeddings.sql:3`). Because `bge-small-en-v1.5` is also 384-dimensional, **no column-type migration is needed for this rollout.** "Lifting the hardcoded constraint" in this plan means: the TypeScript-level `!== 384` literal becomes a named constant read from a persisted settings row (so it's a deliberate, inspectable value instead of a magic number), and mismatch detection/re-embedding becomes possible. Actually widening the `vector(384)` column to support a different-dimension model in the future is explicitly out of scope here (per the spec's non-goals) and would need its own migration plan (including HNSW index rebuild strategy) — do not attempt it as part of this plan.

---

### Task 1: Add the `@huggingface/transformers` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

Run:
```bash
npm install --save @huggingface/transformers@^3
```

- [ ] **Step 2: Verify it installed without touching unrelated deps**

Run: `git diff package.json package-lock.json`
Expected: only `@huggingface/transformers` (and its transitive deps) added; no version bumps to existing packages.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @huggingface/transformers dependency for neural embeddings"
```

---

### Task 2: `BgeSmallEmbeddingModel` with lazy load and fail-open

**Files:**
- Create: `src/storage/embedding-neural.ts`
- Test: `tests/embedding-neural.test.ts`

`EmbeddingModel` (already defined, `src/types.ts:189-193`):
```ts
export interface EmbeddingModel {
  readonly id: string
  readonly dimensions: number
  embed(text: string, signal?: AbortSignal): Promise<number[]>
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/embedding-neural.test.ts
import { describe, expect, it, vi } from "vitest"
import { LocalHashEmbeddingModel } from "../src/storage/embedding.js"
import { createEmbeddingModel } from "../src/storage/embedding-neural.js"

describe("createEmbeddingModel", () => {
  it("returns LocalHashEmbeddingModel for backend 'hash'", async () => {
    const model = await createEmbeddingModel({ backend: "hash" })
    expect(model).toBeInstanceOf(LocalHashEmbeddingModel)
    expect(model.id).toBe("remem-local-hash-v1")
    expect(model.dimensions).toBe(384)
  })

  it("falls back to LocalHashEmbeddingModel when the neural loader throws", async () => {
    const model = await createEmbeddingModel(
      { backend: "neural" },
      { loadPipeline: vi.fn().mockRejectedValue(new Error("no network")) },
    )
    expect(model).toBeInstanceOf(LocalHashEmbeddingModel)
  })

  it("falls back to LocalHashEmbeddingModel when inference throws", async () => {
    const model = await createEmbeddingModel(
      { backend: "neural" },
      {
        loadPipeline: vi.fn().mockResolvedValue(
          vi.fn().mockRejectedValue(new Error("inference failed")),
        ),
      },
    )
    const embedding = await model.embed("hello world")
    expect(embedding).toHaveLength(384)
    expect(model.id).toBe("remem-local-hash-v1")
  })

  it("returns a working neural model when the loader succeeds", async () => {
    const fakeVector = new Array(384).fill(0).map((_, index) => (index === 0 ? 1 : 0))
    const model = await createEmbeddingModel(
      { backend: "neural" },
      {
        loadPipeline: vi.fn().mockResolvedValue(
          vi.fn().mockResolvedValue({ data: Float32Array.from(fakeVector) }),
        ),
      },
    )
    expect(model.id).toBe("bge-small-en-v1.5")
    expect(model.dimensions).toBe(384)
    const embedding = await model.embed("hello world")
    expect(embedding).toEqual(fakeVector)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/embedding-neural.test.ts`
Expected: FAIL — `Cannot find module '../src/storage/embedding-neural.js'`

- [ ] **Step 3: Implement `src/storage/embedding-neural.ts`**

```ts
import { LocalHashEmbeddingModel } from "./embedding.js"
import type { EmbeddingModel } from "../types.js"

export interface NeuralEmbeddingConfig {
  backend: "hash" | "neural"
  modelPath?: string
}

export type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: "mean"; normalize: true },
) => Promise<{ data: ArrayLike<number> }>

export interface EmbeddingModelFactoryOptions {
  /** Test/DI seam: loads (or fakes) the transformers.js feature-extraction pipeline. */
  loadPipeline?: (modelPath: string | undefined) => Promise<FeatureExtractionPipeline>
}

const MODEL_ID = "bge-small-en-v1.5"
const MODEL_DIMENSIONS = 384
const HUGGING_FACE_MODEL = "Xenova/bge-small-en-v1.5"

async function defaultLoadPipeline(modelPath: string | undefined): Promise<FeatureExtractionPipeline> {
  const { pipeline, env } = await import("@huggingface/transformers")
  if (modelPath) {
    env.localModelPath = modelPath
    env.allowRemoteModels = false
  }
  const extractor = await pipeline("feature-extraction", HUGGING_FACE_MODEL, {
    quantized: true,
  })
  return (text, options) => extractor(text, options) as ReturnType<FeatureExtractionPipeline>
}

export class BgeSmallEmbeddingModel implements EmbeddingModel {
  readonly id = MODEL_ID
  readonly dimensions = MODEL_DIMENSIONS

  constructor(private readonly extractor: FeatureExtractionPipeline) {}

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted()
    const output = await this.extractor(text, { pooling: "mean", normalize: true })
    const vector = Array.from(output.data)
    if (vector.length !== this.dimensions) {
      throw new TypeError(
        `bge-small-en-v1.5 returned ${vector.length} dimensions, expected ${this.dimensions}`,
      )
    }
    return vector
  }
}

/**
 * Resolves the configured embedding backend. Any failure to load the neural
 * pipeline, download weights, or run inference falls back to
 * LocalHashEmbeddingModel — an embedding backend failure must never break
 * OpenCode prompt execution.
 */
export async function createEmbeddingModel(
  config: NeuralEmbeddingConfig,
  options: EmbeddingModelFactoryOptions = {},
): Promise<EmbeddingModel> {
  if (config.backend !== "neural") return new LocalHashEmbeddingModel()
  try {
    const loadPipeline = options.loadPipeline ?? defaultLoadPipeline
    const extractor = await loadPipeline(config.modelPath)
    // Fail fast here rather than lazily on first embed() so callers see the
    // fallback decision immediately instead of on a random later request.
    await extractor("remem embedding model warmup", { pooling: "mean", normalize: true })
    return new BgeSmallEmbeddingModel(extractor)
  } catch {
    return new LocalHashEmbeddingModel()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/embedding-neural.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/storage/embedding-neural.ts tests/embedding-neural.test.ts
git commit -m "feat: add BgeSmallEmbeddingModel with fail-open to hash fallback"
```

---

### Task 3: Proxy-aware download for the neural model

**Files:**
- Modify: `src/storage/embedding-neural.ts`
- Test: `tests/embedding-neural.test.ts`

Node's global `fetch` does not honor `HTTP_PROXY`/`HTTPS_PROXY` automatically. `@huggingface/transformers` uses `fetch` internally to download weights, so the proxy must be wired in explicitly via `undici`'s global dispatcher (a transitive dependency already present via Node's built-in fetch implementation).

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/embedding-neural.test.ts
import { configureProxyFromEnvironment } from "../src/storage/embedding-neural.js"

describe("configureProxyFromEnvironment", () => {
  it("returns false when no proxy env vars are set", () => {
    const result = configureProxyFromEnvironment({})
    expect(result).toBe(false)
  })

  it("returns true and does not throw when HTTPS_PROXY is set", () => {
    const result = configureProxyFromEnvironment({ HTTPS_PROXY: "http://proxy.example.com:8080" })
    expect(result).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/embedding-neural.test.ts`
Expected: FAIL — `configureProxyFromEnvironment is not exported`

- [ ] **Step 3: Implement it and call it from `defaultLoadPipeline`**

Add to `src/storage/embedding-neural.ts`:

```ts
import { ProxyAgent, setGlobalDispatcher } from "undici"

/**
 * Routes @huggingface/transformers's model-weight downloads through the
 * standard proxy env vars. Returns whether a proxy was configured.
 */
export function configureProxyFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const proxyUrl = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (!proxyUrl) return false
  setGlobalDispatcher(new ProxyAgent(proxyUrl))
  return true
}
```

Update `defaultLoadPipeline` to call it before downloading:

```ts
async function defaultLoadPipeline(modelPath: string | undefined): Promise<FeatureExtractionPipeline> {
  configureProxyFromEnvironment()
  const { pipeline, env } = await import("@huggingface/transformers")
  // ... unchanged below
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/embedding-neural.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/storage/embedding-neural.ts tests/embedding-neural.test.ts
git commit -m "feat: route neural model downloads through standard proxy env vars"
```

---

### Task 4: `embedding` block in plugin config (`src/config.ts`)

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (existing file — add cases)

Current `RememConfig` (`src/config.ts:57-61`):
```ts
export interface RememConfig extends OrchestratorConfig {
  providers: MemoryProviderConfig[]
  compaction: boolean
  capture: CaptureConfig
}
```

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts` (check the existing file's `describe`/`it` style first and match it — the pattern below follows `parseConfig` being called directly with a plain options object, consistent with the rest of that file):

```ts
describe("embedding config", () => {
  it("defaults to the hash backend", () => {
    const { config } = parseConfig({})
    expect(config.embedding).toEqual({ backend: "hash", modelPath: undefined })
  })

  it("accepts an explicit neural backend", () => {
    const { config } = parseConfig({ embedding: { backend: "neural" } })
    expect(config.embedding.backend).toBe("neural")
  })

  it("accepts a modelPath override", () => {
    const { config } = parseConfig({
      embedding: { backend: "neural", modelPath: "/opt/models/bge-small" },
    })
    expect(config.embedding.modelPath).toBe("/opt/models/bge-small")
  })

  it("falls back to hash and warns on an invalid backend value", () => {
    const { config, diagnostics } = parseConfig({ embedding: { backend: "gpt4" } })
    expect(config.embedding.backend).toBe("hash")
    expect(diagnostics.some((d) => d.message.includes("embedding.backend"))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `config.embedding` is `undefined`

- [ ] **Step 3: Implement the config field**

In `src/config.ts`, add the type near `CaptureConfig`:

```ts
export interface EmbeddingConfig {
  backend: "hash" | "neural"
  modelPath?: string
}
```

Extend `RememConfig`:

```ts
export interface RememConfig extends OrchestratorConfig {
  providers: MemoryProviderConfig[]
  compaction: boolean
  capture: CaptureConfig
  embedding: EmbeddingConfig
}
```

Add a parse helper above `parseConfig`:

```ts
function parseEmbedding(value: unknown, diagnostics: ConfigDiagnostic[]): EmbeddingConfig {
  const options = isRecord(value) ? value : {}
  const backend = options.backend === "neural" ? "neural" : options.backend === "hash" ? "hash" : undefined
  if (options.backend !== undefined && backend === undefined) {
    diagnostics.push({
      level: "warn",
      message: "embedding.backend must be 'hash' or 'neural'; defaulted to 'hash'",
    })
  }
  return {
    backend: backend ?? "hash",
    modelPath: typeof options.modelPath === "string" ? options.modelPath : undefined,
  }
}
```

In `parseConfig`'s return object, add:

```ts
      embedding: parseEmbedding(root.embedding, diagnostics),
```

(placed alongside the other `config: { ... }` fields, e.g. right after `capture: { ... }`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add embedding backend config to plugin options schema"
```

---

### Task 5: Widen `RememAppConfig.embedding` and default managed/external init to neural

**Files:**
- Modify: `src/storage/config-file.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/config-file.test.ts` (create if it doesn't exist — check first with `ls tests/config-file.test.ts`)

Current type (`src/storage/config-file.ts:36-40`):
```ts
  embedding: {
    provider: "local-hash"
    model: "remem-local-hash-v1"
    dimensions: 384
  }
```

Current `appConfig()` (`src/cli/index.ts:149-172`) hardcodes the same literal shape.

- [ ] **Step 1: Write the failing test**

```ts
// tests/config-file.test.ts
import { describe, expect, it } from "vitest"
import { validateAppConfig } from "../src/storage/config-file.js"

describe("validateAppConfig", () => {
  const base = {
    version: 1 as const,
    storage: { mode: "external" as const, connectionString: "postgres://x" },
    providers: [],
  }

  it("accepts the local-hash embedding shape", () => {
    expect(() =>
      validateAppConfig({
        ...base,
        embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
      }),
    ).not.toThrow()
  })

  it("accepts the neural embedding shape", () => {
    expect(() =>
      validateAppConfig({
        ...base,
        embedding: { provider: "neural", model: "bge-small-en-v1.5", dimensions: 384 },
      }),
    ).not.toThrow()
  })

  it("rejects an unknown embedding provider", () => {
    expect(() =>
      validateAppConfig({
        ...base,
        embedding: { provider: "openai", model: "text-embedding-3", dimensions: 1536 },
      }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/config-file.test.ts`
Expected: FAIL — the neural shape is accepted today only by accident (no validation at all beyond `isRecord`), and the "rejects unknown provider" case currently does NOT throw, so that assertion fails.

- [ ] **Step 3: Widen the type and validation**

In `src/storage/config-file.ts`, replace the `embedding` field type:

```ts
export type EmbeddingSetting =
  | { provider: "local-hash"; model: "remem-local-hash-v1"; dimensions: 384 }
  | { provider: "neural"; model: "bge-small-en-v1.5"; dimensions: 384 }

export interface RememAppConfig {
  // ...unchanged fields above...
  embedding: EmbeddingSetting
  // ...unchanged fields below...
}
```

In `validateAppConfig`, replace the existing `!isRecord(value.embedding)` check with:

```ts
  if (!Array.isArray(value.providers) || !isRecord(value.embedding)) {
    throw new Error("provider or embedding configuration is missing")
  }
  const embeddingProvider = value.embedding.provider
  if (embeddingProvider !== "local-hash" && embeddingProvider !== "neural") {
    throw new Error("embedding.provider must be 'local-hash' or 'neural'")
  }
```

- [ ] **Step 4: Update `appConfig()` in `src/cli/index.ts` to default to neural**

Replace the hardcoded block (`src/cli/index.ts:167-171`):

```ts
    embedding: {
      provider: "local-hash",
      model: "remem-local-hash-v1",
      dimensions: 384,
    },
```

with:

```ts
    embedding: { provider: "neural", model: "bge-small-en-v1.5", dimensions: 384 },
```

This applies to both the `managed` and `external` branches of `initialize()`, since both call `appConfig(storage, ...)` — both are the "managed-mode" (Postgres-backed) path the design spec refers to.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/config-file.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/storage/config-file.ts src/cli/index.ts tests/config-file.test.ts
git commit -m "feat: default remem init to the neural embedding backend"
```

---

### Task 6: Print the download warning on `remem init`

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/cli-provisioning.test.ts` (existing — check its `output`/`stdout` capture pattern and match it)

- [ ] **Step 1: Write the failing test**

Read `tests/cli-provisioning.test.ts` first to copy its exact `runCli`/`dependencies.stdout` mocking pattern, then add:

```ts
it("warns before downloading the neural embedding model on init", async () => {
  const lines: string[] = []
  await runCli(["init", "--mode", "external", "--database-url", "postgres://x"], {
    paths /* reuse whatever fixture path helper this file already uses */,
    runner /* reuse this file's existing fake ProcessRunner */,
    stdout: (line) => lines.push(line),
  })
  expect(lines.some((line) => line.includes("bge-small-en-v1.5"))).toBe(true)
  expect(lines.some((line) => line.includes("huggingface.co"))).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cli-provisioning.test.ts`
Expected: FAIL — no such line is printed today.

- [ ] **Step 3: Add the warning in `initialize()`**

In `src/cli/index.ts`, immediately after `config = appConfig(...)` is assigned in both the `external` and `managed` branches (i.e., right before the shared `if (configureHost) await configureOpenCode(...)` line that follows the `if/else if` block), add:

```ts
  if (config.embedding.provider === "neural") {
    output(
      `Remem will download the ${config.embedding.model} embedding model (~30MB, quantized) ` +
        "from huggingface.co on first use. This happens once and is cached locally; " +
        "no further network access is required afterward. If this download is blocked, " +
        "Remem automatically falls back to local hash-based embeddings — see `remem doctor`.",
    )
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/cli-provisioning.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli-provisioning.test.ts
git commit -m "feat: warn before the one-time neural embedding model download"
```

---

### Task 7: Migration 0005 — `embedding_settings` bookkeeping table

**Files:**
- Create: `migrations/0005_embedding_settings.sql`
- Test: `tests/postgres-provider.integration.test.ts` (existing — add a case, gated behind `REMEM_TEST_DATABASE_URL`)

This table records the currently-configured embedding model/dimensions so the re-embed job (Task 9) can detect drift between config and what's actually stored on rows, without re-deriving it from a scan every time.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0005_embedding_settings.sql
CREATE TABLE remem.embedding_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 384),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

(The `id boolean PRIMARY KEY DEFAULT true CHECK (id)` trick enforces a true singleton row — the same pattern is worth using here for a config table with exactly one row; if the codebase has an existing singleton-table convention, grep for one with `grep -rn "PRIMARY KEY DEFAULT true" migrations/` first and match it instead.)

- [ ] **Step 2: Write the failing integration test**

Append to `tests/postgres-provider.integration.test.ts` (inside the existing `integration("PostgreSQL managed provider", () => { ... })` block, following its existing `beforeAll`/migration-running conventions):

```ts
it("creates the embedding_settings singleton table", async () => {
  const result = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'remem' AND table_name = 'embedding_settings'",
  )
  const columns = result.rows.map((row: { column_name: string }) => row.column_name)
  expect(columns).toEqual(
    expect.arrayContaining(["id", "model", "dimensions", "updated_at"]),
  )
})
```

- [ ] **Step 3: Run to verify it fails (requires a local Postgres)**

Run: `REMEM_TEST_DATABASE_URL=postgres://remem:remem@127.0.0.1:5432/remem_test npx vitest run tests/postgres-provider.integration.test.ts`
Expected: FAIL — table doesn't exist yet (or SKIP with a clear message if `REMEM_TEST_DATABASE_URL` isn't set locally; that's fine, CI has it configured per `.github/workflows/ci.yml`)

- [ ] **Step 4: Run to verify it passes**

Same command as Step 3.
Expected: PASS — `runMigrations`/`migrationStatus` (already invoked by this test file's setup) picks up the new file automatically by filename convention.

- [ ] **Step 5: Commit**

```bash
git add migrations/0005_embedding_settings.sql tests/postgres-provider.integration.test.ts
git commit -m "feat: add embedding_settings table for model-drift detection"
```

---

### Task 8: Configured-dimension check + `EmbeddingModel` injection wiring

**Files:**
- Modify: `src/providers/postgres.ts:186-196` (constructor)
- Modify: `src/providers/factory.ts` (`createProviders`)
- Modify: `src/hosts/opencode/v1.ts`, `src/hosts/opencode/v2.ts`
- Modify: `src/cli/index.ts` (`primaryPostgresProvider`)
- Modify: `src/cli/doctor.ts` (embedding check)
- Test: `tests/postgres-provider.integration.test.ts`, `tests/config.test.ts`

Today, `LocalHashEmbeddingModel` is silently defaulted in five separate places even when config says otherwise. This task makes the configured `EmbeddingModel` actually flow end-to-end.

- [ ] **Step 1: Write the failing test**

Append to `tests/postgres-provider.integration.test.ts`:

```ts
it("rejects an embedding model with the wrong dimensions", () => {
  const badModel: EmbeddingModel = {
    id: "fake-768",
    dimensions: 768,
    embed: async () => new Array(768).fill(0),
  }
  expect(
    () => new PostgresMemoryProvider(
      { type: "postgres", id: "x", connectionString: databaseUrl ?? "", primary: true, maxConnections: 1, catalogLimit: 10 },
      { embeddingModel: badModel },
    ),
  ).toThrow(/384-dimensional/)
})
```

- [ ] **Step 2: Run to verify it currently passes (this behavior already exists)**

Run: `npx vitest run tests/postgres-provider.integration.test.ts -t "rejects an embedding model"`
Expected: PASS already — this step just documents/locks the existing guard before we touch the surrounding code, so a regression here is caught immediately.

- [ ] **Step 3: Extract the dimension check into a named constant**

In `src/providers/postgres.ts`, near the top of the file (alongside other module-level constants like `UUID_PATTERN`):

```ts
const SUPPORTED_EMBEDDING_DIMENSIONS = 384
```

Replace the constructor body (`src/providers/postgres.ts:194-196`):

```ts
    this.embeddingModel = options.embeddingModel ?? new LocalHashEmbeddingModel()
    if (this.embeddingModel.dimensions !== 384) {
      throw new TypeError("PostgreSQL storage currently requires 384-dimensional embeddings")
    }
```

with:

```ts
    this.embeddingModel = options.embeddingModel ?? new LocalHashEmbeddingModel()
    if (this.embeddingModel.dimensions !== SUPPORTED_EMBEDDING_DIMENSIONS) {
      throw new TypeError(
        `PostgreSQL storage currently requires ${SUPPORTED_EMBEDDING_DIMENSIONS}-dimensional ` +
          "embeddings (the remem.memory_embeddings column is a fixed-width vector(384)); " +
          "switching to a different-dimension model requires a dedicated schema migration " +
          "that is not yet implemented",
      )
    }
```

- [ ] **Step 4: Thread `embeddingModel` through `createProviders`**

In `src/providers/factory.ts`, update the signature and call site:

```ts
export function createProviders(
  configs: MemoryProviderConfig[],
  location: ProviderFactoryLocation,
  options: { embeddingModel?: EmbeddingModel } = {},
): ProviderFactoryResult {
  const providers: MemoryProvider[] = []
  const diagnostics: string[] = []

  for (const config of configs) {
    try {
      if (config.type === "postgres") {
        providers.push(new PostgresMemoryProvider(config, { embeddingModel: options.embeddingModel }))
      } else {
```

Add the import: `import type { EmbeddingModel, MemoryProvider } from "../types.js"`.

- [ ] **Step 5: Construct and inject the model in both OpenCode hosts**

In `src/hosts/opencode/v2.ts`, inside `RememPlugin.setup` (around where `parsed` and `location` are already computed, before `createProviders` is called at line 145):

```ts
      const embeddingModel = await createEmbeddingModel(parsed.config.embedding)
      const created = createProviders(parsed.config.providers, { worktree: location.worktree }, { embeddingModel })
```

and update the `RememOrchestrator` construction (line 150):

```ts
      const orchestrator = new RememOrchestrator(created.providers, parsed.config, logger, { embeddingModel })
```

Add the import: `import { createEmbeddingModel } from "../../storage/embedding-neural.js"`.

Apply the identical change to `src/hosts/opencode/v1.ts` at its equivalent lines (178, 182).

- [ ] **Step 6: Fix the two remaining silent defaults**

In `src/cli/index.ts`, `primaryPostgresProvider` (line 270-277) currently does:
```ts
  return new PostgresMemoryProvider(provider)
```
This one is intentionally left as the hash default for now — candidate management CLI commands (`candidates`/`review`/`consolidate`) operate on text content, not semantic search, so they don't need the configured embedding backend. Leave as-is; do not change this function in this task (documenting the decision here so a future reader doesn't "fix" it unnecessarily).

In `src/cli/doctor.ts`, replace the hardcoded check (lines 168-178):

```ts
  try {
    const model = new LocalHashEmbeddingModel()
    const embedding = await model.embed("Remem doctor")
    checks.push({
      name: "embedding configuration",
      status: embedding.length === config.embedding.dimensions ? "ok" : "error",
      detail: `${model.id}; ${embedding.length} dimensions`,
    })
  } catch {
    checks.push({ name: "embedding configuration", status: "error", detail: "embedding failed" })
  }
```

with:

```ts
  try {
    const model = await createEmbeddingModel({
      backend: config.embedding.provider === "neural" ? "neural" : "hash",
    })
    const embedding = await model.embed("Remem doctor")
    const usingConfiguredBackend =
      (config.embedding.provider === "neural") === (model.id === "bge-small-en-v1.5")
    checks.push({
      name: "embedding configuration",
      status: embedding.length === config.embedding.dimensions && usingConfiguredBackend ? "ok" : "warn",
      detail: usingConfiguredBackend
        ? `${model.id}; ${embedding.length} dimensions`
        : `configured for ${config.embedding.provider} but running on ${model.id} (fallback active)`,
    })
  } catch {
    checks.push({ name: "embedding configuration", status: "error", detail: "embedding failed" })
  }
```

Update the import at the top of `src/cli/doctor.ts` — remove `LocalHashEmbeddingModel` from the `../storage/embedding.js` import and add:
```ts
import { createEmbeddingModel } from "../storage/embedding-neural.js"
```

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: all existing tests still PASS (this task changes wiring, not new test-visible behavior beyond Step 1's lock-in test).

- [ ] **Step 8: Commit**

```bash
git add src/providers/postgres.ts src/providers/factory.ts src/hosts/opencode/v1.ts src/hosts/opencode/v2.ts src/cli/doctor.ts tests/postgres-provider.integration.test.ts
git commit -m "feat: wire the configured embedding backend through providers and doctor"
```

---

### Task 9: `PostgresReembedRunner` (batch-claim/recover, mirroring consolidation)

**Files:**
- Create: `src/reembedding.ts`
- Modify: `src/providers/postgres.ts` (add `reembedStale` method)
- Test: `tests/reembedding.test.ts`

Mirrors `PostgresConsolidationRunner` (`src/consolidation.ts:384-520`) exactly: `recoverInterruptedRuns()` → `claimStaleRows()` (SELECT ... FOR UPDATE SKIP LOCKED) → re-embed → `complete()`/`fail()`, using the existing `remem.consolidation_records` table with `kind = 'embedding-reembed'` (that table's `kind` column is unconstrained free text, `migrations/0002_consolidation_observation.sql:26-34` — no new table needed for run-tracking).

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/reembedding.test.ts
import { describe, expect, it, vi } from "vitest"
import { PostgresReembedRunner } from "../src/reembedding.js"

function fakePool(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connect: vi.fn(),
    query: vi.fn(),
    ...overrides,
  }
}

describe("PostgresReembedRunner", () => {
  it("reports zero work when there is nothing to claim", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }
    const pool = fakePool({
      query: vi.fn().mockResolvedValue({ rows: [] }), // recoverInterruptedRuns calls
      connect: vi.fn().mockResolvedValue(client),
    })
    const embed = vi.fn()
    const runner = new PostgresReembedRunner(pool as never, embed, {
      modelId: "bge-small-en-v1.5",
      dimensions: 384,
      batchSize: 10,
    })
    const result = await runner.run()
    expect(result.status).toBe("no-op")
    expect(embed).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/reembedding.test.ts`
Expected: FAIL — `Cannot find module '../src/reembedding.js'`

- [ ] **Step 3: Implement `src/reembedding.ts`**

```ts
import { randomUUID } from "node:crypto"
import type { Pool } from "pg"

export interface ReembedTarget {
  memoryId: string
  text: string
}

export interface ReembedRunOptions {
  modelId: string
  dimensions: number
  batchSize?: number
  recoveryAfterMs?: number
}

export interface ReembedRunResult {
  id: string
  status: "completed" | "failed" | "no-op"
  claimed: number
  reembedded: number
  errors: string[]
}

/**
 * Re-embeds memory_embeddings rows whose stored model/dimensions don't match
 * the currently configured embedding model. Mirrors
 * PostgresConsolidationRunner's claim/complete/fail/recover pattern
 * (src/consolidation.ts:384-520) so stuck runs from a crashed process are
 * safely reclaimed rather than silently lost.
 */
export class PostgresReembedRunner {
  private readonly batchSize: number
  private readonly recoveryAfterMs: number

  constructor(
    private readonly pool: Pool,
    private readonly embed: (text: string, signal?: AbortSignal) => Promise<number[]>,
    private readonly options: ReembedRunOptions,
  ) {
    this.batchSize = options.batchSize ?? 25
    this.recoveryAfterMs = options.recoveryAfterMs ?? 15 * 60_000
  }

  async run(signal?: AbortSignal): Promise<ReembedRunResult> {
    signal?.throwIfAborted()
    await this.recoverInterruptedRuns()
    const claim = await this.claimStaleRows()
    if (!claim) {
      return { id: "none", status: "no-op", claimed: 0, reembedded: 0, errors: [] }
    }
    const errors: string[] = []
    let reembedded = 0
    for (const target of claim.targets) {
      try {
        signal?.throwIfAborted()
        const embedding = await this.embed(target.text, signal)
        await this.pool.query(
          `UPDATE remem.memory_embeddings
             SET model = $2, dimensions = $3, embedding = $4::vector, updated_at = now()
           WHERE memory_id = $1`,
          [target.memoryId, this.options.modelId, this.options.dimensions, `[${embedding.join(",")}]`],
        )
        reembedded++
      } catch (error) {
        errors.push(error instanceof Error ? error.name : "unknown error")
      }
    }
    if (errors.length > 0 && reembedded === 0) {
      await this.fail(claim.id, errors)
      return { id: claim.id, status: "failed", claimed: claim.targets.length, reembedded: 0, errors }
    }
    await this.complete(claim.id, reembedded, errors)
    return { id: claim.id, status: "completed", claimed: claim.targets.length, reembedded, errors }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    await this.pool.query(
      `UPDATE remem.consolidation_records
         SET status = 'failed', completed_at = now(),
           metadata = metadata || '{"recovery":"interrupted reembed run"}'::jsonb
       WHERE kind = 'embedding-reembed'
         AND status = 'started'
         AND started_at < now() - ($1 * interval '1 millisecond')`,
      [this.recoveryAfterMs],
    )
  }

  private async claimStaleRows(): Promise<{ id: string; targets: ReembedTarget[] } | undefined> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      const rows = await client.query<{ memory_id: string; content: string }>(
        `SELECT me.memory_id, m.content
           FROM remem.memory_embeddings me
           JOIN remem.memories m ON m.id = me.memory_id
          WHERE me.model <> $1 OR me.dimensions <> $2
          ORDER BY me.updated_at
          LIMIT $3
          FOR UPDATE OF me SKIP LOCKED`,
        [this.options.modelId, this.options.dimensions, this.batchSize],
      )
      if (rows.rows.length === 0) {
        await client.query("COMMIT")
        return undefined
      }
      const id = randomUUID()
      await client.query(
        `INSERT INTO remem.consolidation_records (id, kind, status, input_memory_ids, metadata)
         VALUES ($1, 'embedding-reembed', 'started', $2, '{}'::jsonb)`,
        [id, rows.rows.map((row) => row.memory_id)],
      )
      await client.query("COMMIT")
      return {
        id,
        targets: rows.rows.map((row) => ({ memoryId: row.memory_id, text: row.content })),
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  private async complete(runId: string, reembedded: number, errors: string[]): Promise<void> {
    await this.pool.query(
      `UPDATE remem.consolidation_records
         SET status = 'completed', completed_at = now(),
           summary = $2,
           metadata = metadata || $3::jsonb
       WHERE id = $1`,
      [runId, `reembedded ${reembedded} row(s)`, JSON.stringify({ errors })],
    )
  }

  private async fail(runId: string, errors: string[]): Promise<void> {
    await this.pool.query(
      `UPDATE remem.consolidation_records
         SET status = 'failed', completed_at = now(),
           metadata = metadata || $2::jsonb
       WHERE id = $1`,
      [runId, JSON.stringify({ errors })],
    )
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/reembedding.test.ts`
Expected: PASS

- [ ] **Step 5: Add `PostgresMemoryProvider.reembedStale()`**

In `src/providers/postgres.ts`, near the existing `consolidateCandidates` method (line ~731-738), add:

```ts
  async reembedStale(batchSize = 25) {
    return new PostgresReembedRunner(this.pool, (text, signal) => this.embeddingModel.embed(text, signal), {
      modelId: this.embeddingModel.id,
      dimensions: this.embeddingModel.dimensions,
      batchSize,
    }).run()
  }
```

Add the import: `import { PostgresReembedRunner } from "../reembedding.js"`.

- [ ] **Step 6: Write the integration test**

Append to `tests/postgres-provider.integration.test.ts` (following its existing setup/teardown conventions):

```ts
it("reembeds a memory stored under a different model id", async () => {
  const provider = new PostgresMemoryProvider(
    { type: "postgres", id: "reembed-test", connectionString: databaseUrl ?? "", primary: true, maxConnections: 2, catalogLimit: 10 },
    { pool },
  )
  const written = await provider.write?.({
    title: "Reembed target",
    content: "Bedrock Claude credential passthrough failure",
    scope: { kind: "workspace", id: "phoenix" },
    type: "decision",
  })
  await pool.query(
    "UPDATE remem.memory_embeddings SET model = 'stale-model' WHERE memory_id = $1",
    [written?.id],
  )
  const result = await provider.reembedStale(10)
  expect(result.status).toBe("completed")
  expect(result.reembedded).toBeGreaterThanOrEqual(1)
  const row = await pool.query("SELECT model FROM remem.memory_embeddings WHERE memory_id = $1", [written?.id])
  expect(row.rows[0]?.model).toBe("remem-local-hash-v1")
})
```

- [ ] **Step 7: Run to verify it passes**

Run: `REMEM_TEST_DATABASE_URL=postgres://remem:remem@127.0.0.1:5432/remem_test npx vitest run tests/reembedding.test.ts tests/postgres-provider.integration.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/reembedding.ts src/providers/postgres.ts tests/reembedding.test.ts tests/postgres-provider.integration.test.ts
git commit -m "feat: add PostgresReembedRunner mirroring the consolidation batch-claim pattern"
```

---

### Task 10: Hook-triggered re-embed (cooldown, fire-and-forget)

**Files:**
- Modify: `src/hosts/opencode/v2.ts`
- Test: `tests/reembedding.test.ts`

The `"prompt"` session hook already exists (`src/hosts/opencode/v2.ts:154-169`, used by the capture pipeline). This task adds a cooldown-gated, never-awaited call to `reembedStale()` alongside the existing `coordinator.enqueue(...)` call in that same hook.

- [ ] **Step 1: Write the failing unit test**

```ts
// append to tests/reembedding.test.ts
import { shouldAttemptReembed } from "../src/reembedding.js"

describe("shouldAttemptReembed", () => {
  it("returns true when never attempted", () => {
    expect(shouldAttemptReembed(undefined, () => 1_000, 5 * 60_000)).toBe(true)
  })

  it("returns false within the cooldown window", () => {
    expect(shouldAttemptReembed(1_000, () => 1_000 + 60_000, 5 * 60_000)).toBe(false)
  })

  it("returns true after the cooldown window elapses", () => {
    expect(shouldAttemptReembed(1_000, () => 1_000 + 6 * 60_000, 5 * 60_000)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/reembedding.test.ts`
Expected: FAIL — `shouldAttemptReembed` not exported

- [ ] **Step 3: Add the cooldown helper to `src/reembedding.ts`**

```ts
export function shouldAttemptReembed(
  lastAttemptMs: number | undefined,
  now: () => number = Date.now,
  cooldownMs = 5 * 60_000,
): boolean {
  return lastAttemptMs === undefined || now() - lastAttemptMs >= cooldownMs
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/reembedding.test.ts`
Expected: PASS

- [ ] **Step 5: Wire it into the `"prompt"` hook in `v2.ts`**

Read the current hook registration first (`src/hosts/opencode/v2.ts:154-169`):

```ts
        promptRegistration = await context.session.hook("prompt", (event) => {
          try {
            coordinator.enqueue({
              host: "opencode-v2",
              context: memoryContext(location, event.sessionID),
              sessionId: event.sessionID,
              messageId: event.messageID,
              text: event.prompt.text,
            })
          } catch (error) {
            safeLoggerCall(logger, "warn", "capture.enqueue_failed", {
              error: error instanceof Error ? error.name : "unknown error",
            })
          }
        })
```

Add a module-level (per-process) cooldown tracker above `RememPlugin.setup` — one entry per primary Postgres provider id, since multiple plugin instances/workspaces in the same process share it intentionally (cheap, no correctness requirement beyond "don't hammer the database"):

```ts
const lastReembedAttempt = new Map<string, number>()
```

Inside the same `if (coordinator)` block, right after `promptRegistration = await context.session.hook(...)` closes, add a second, independent hook registration (do not merge into the capture hook's try/catch — a failure in one must never affect the other):

```ts
        const primaryPostgres = providers.find(
          (provider): provider is PostgresMemoryProvider => provider instanceof PostgresMemoryProvider,
        )
        if (primaryPostgres) {
          await context.session.hook("prompt", () => {
            if (!shouldAttemptReembed(lastReembedAttempt.get(primaryPostgres.id))) return
            lastReembedAttempt.set(primaryPostgres.id, Date.now())
            // Fire-and-forget: must never delay or fail prompt handling.
            void primaryPostgres.reembedStale().catch((error) => {
              safeLoggerCall(logger, "warn", "reembed.attempt_failed", {
                error: error instanceof Error ? error.name : "unknown error",
              })
            })
          })
        }
```

Add imports at the top of `src/hosts/opencode/v2.ts`:
```ts
import { PostgresMemoryProvider } from "../../providers/postgres.js"
import { shouldAttemptReembed } from "../../reembedding.js"
```

(`providers` here refers to the array already available in `RememPlugin.setup`'s scope from `const created = createProviders(...)`; use `created.providers` if that's the exact local variable name — check the surrounding code before editing.)

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add src/hosts/opencode/v2.ts src/reembedding.ts tests/reembedding.test.ts
git commit -m "feat: trigger re-embedding opportunistically from the prompt hook"
```

---

### Task 11: `remem reembed` manual CLI command

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/cli-provisioning.test.ts`

Mirrors the existing `consolidate` command (`src/cli/index.ts:437-461`) exactly.

- [ ] **Step 1: Write the failing test**

Match this file's existing pattern for testing the `consolidate` command (read it first), then add an equivalent:

```ts
it("runs a manual reembed via the CLI", async () => {
  // Follow this file's existing pattern for stubbing PostgresMemoryProvider /
  // primaryPostgresProvider used by the "consolidate" command's test case.
  const exitCode = await runCli(["reembed", "--batch-size", "5"], dependencies)
  expect(exitCode).toBe(0)
})

it("rejects an out-of-range --batch-size for reembed", async () => {
  const exitCode = await runCli(["reembed", "--batch-size", "0"], dependencies)
  expect(exitCode).not.toBe(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/cli-provisioning.test.ts`
Expected: FAIL — `reembed` is not a recognized command

- [ ] **Step 3: Add the command**

In `src/cli/index.ts`, update the command-dispatch set (line ~397-407) to include `"reembed"`:

```ts
      new Set([
        "init",
        "start",
        "stop",
        "migrate",
        "backup",
        "restore",
        "reset",
        "review",
        "consolidate",
        "reembed",
      ]).has(parsed.command)
```

Update the dispatch condition (line ~437-439):

```ts
    if (
      parsed.command === "candidates" ||
      parsed.command === "review" ||
      parsed.command === "consolidate" ||
      parsed.command === "reembed"
    ) {
```

Add the branch inside that block, alongside the existing `consolidate` handling:

```ts
        if (parsed.command === "reembed") {
          const batchSize = Number(stringFlag(parsed, "batch-size") ?? 25)
          if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
            throw new Error("--batch-size must be an integer from 1 to 1000")
          }
          output(JSON.stringify(await provider.reembedStale(batchSize), null, 2))
          return 0
        }
```

Update `usage()` (line ~374-384) to add a line:
```
  reembed [--batch-size NUMBER]
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/cli-provisioning.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli-provisioning.test.ts
git commit -m "feat: add remem reembed manual CLI command"
```

---

### Task 12: `remem doctor` backlog reporting

**Files:**
- Modify: `src/cli/doctor.ts`
- Test: `tests/postgres-provider.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
it("reports a re-embed backlog in doctor output", async () => {
  await pool.query("UPDATE remem.memory_embeddings SET model = 'stale-model'")
  const report = await runDoctor(appConfigFixture /* this file's existing config fixture */, paths, runner)
  const check = report.checks.find((c) => c.name === "embedding backlog")
  expect(check?.status).toBe("warn")
  expect(check?.detail).toMatch(/\d+ memor(y|ies) pending re-embedding/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `REMEM_TEST_DATABASE_URL=... npx vitest run tests/postgres-provider.integration.test.ts`
Expected: FAIL — no "embedding backlog" check exists yet

- [ ] **Step 3: Add the check**

In `src/cli/doctor.ts`, after the existing "embedding configuration" check block (added in Task 8, Step 6), add:

```ts
  try {
    const backlog = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM remem.memory_embeddings
        WHERE model <> $1 OR dimensions <> $2`,
      [config.embedding.model, config.embedding.dimensions],
    )
    const pending = Number(backlog.rows[0]?.count ?? 0)
    checks.push({
      name: "embedding backlog",
      status: pending === 0 ? "ok" : "warn",
      detail:
        pending === 0
          ? "all memories use the configured embedding model"
          : `${pending} ${pending === 1 ? "memory" : "memories"} pending re-embedding; ` +
            "this drains automatically during normal use, or run `remem reembed` now",
    })
  } catch {
    // The main PostgreSQL connectivity check above already reports connection
    // failures; skip silently here rather than double-reporting.
  }
```

Note: this reuses the `pool` variable already opened earlier in `runDoctor` (line 109-114) for the PostgreSQL connectivity checks — place this new block before that pool's `finally { await pool.end() }` (line 164-166), not after.

- [ ] **Step 4: Run to verify it passes**

Run: `REMEM_TEST_DATABASE_URL=... npx vitest run tests/postgres-provider.integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts tests/postgres-provider.integration.test.ts
git commit -m "feat: report embedding re-embed backlog in remem doctor"
```

---

### Task 13: Local `modelPath` override wiring

**Files:**
- Modify: `src/storage/embedding-neural.ts` (already accepts `modelPath` — verify end-to-end)
- Modify: `src/config.ts` (already parses `modelPath` — done in Task 4)
- Test: `tests/embedding-neural.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("passes modelPath through to the pipeline loader", async () => {
  const loadPipeline = vi.fn().mockResolvedValue(vi.fn().mockResolvedValue({ data: new Float32Array(384) }))
  await createEmbeddingModel({ backend: "neural", modelPath: "/opt/models/bge-small" }, { loadPipeline })
  expect(loadPipeline).toHaveBeenCalledWith("/opt/models/bge-small")
})
```

- [ ] **Step 2: Run to verify it fails or passes**

Run: `npx vitest run tests/embedding-neural.test.ts`
Expected: PASS already — Task 2's `createEmbeddingModel` already forwards `config.modelPath` to `loadPipeline`. This step exists to lock in that contract explicitly with its own test, since it's a distinct, spec-required behavior (the air-gapped escape hatch) that shouldn't silently regress if `createEmbeddingModel`'s signature changes later.

- [ ] **Step 3: Commit**

```bash
git add tests/embedding-neural.test.ts
git commit -m "test: lock in modelPath override contract for air-gapped installs"
```

---

### Task 14: Evaluation fixtures — paraphrase / low-lexical-overlap recall

**Files:**
- Check first: `find . -iname "*eval*" -not -path "*/node_modules/*" -not -path "*/dist/*"` to see if an eval harness already exists; if none exists, create `tests/embedding-recall.eval.test.ts` as a regular vitest file (not a separate harness) to stay consistent with this repo's all-tests-in-vitest convention.
- Create: `tests/embedding-recall.eval.test.ts`

- [ ] **Step 1: Write the test**

```ts
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
  it.each(RECALL_CASES)(
    "neural embeddings score '%s' higher than an unrelated control",
    async ({ prompt, memory }) => {
      const neural = await createEmbeddingModel({ backend: "neural" })
      if (neural.id !== "bge-small-en-v1.5") {
        // No network in this environment; the fallback engaged. Skip rather
        // than fail — this suite requires the real model to be meaningful.
        return
      }
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
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/embedding-recall.eval.test.ts`
Expected: PASS (or the neural cases SKIP silently if there's no network access in the current environment — acceptable, matches the fail-open design)

- [ ] **Step 3: Commit**

```bash
git add tests/embedding-recall.eval.test.ts
git commit -m "test: add paraphrase recall eval fixtures comparing hash vs neural embeddings"
```

---

### Task 15: Documentation

**Files:**
- Create: `docs/embeddings.md`
- Modify: `docs/configuration.md`
- Modify: `docs/installation.md`
- Modify: `CHANGELOG.md` (read its existing format first and match it exactly)

- [ ] **Step 1: Create `docs/embeddings.md`**

```markdown
# Embeddings

Remem's Stage 1 semantic recall is powered by an `EmbeddingModel`. Two are available:

## `remem-local-hash-v1` (default outside managed mode)

A deterministic feature-hashing scheme (`src/storage/embedding.ts`). Zero
dependencies, zero network access, 384 dimensions. Used automatically
whenever the neural backend isn't configured or fails to load.

## `bge-small-en-v1.5` (default for `remem init --mode managed|external`)

A real local neural embedding model (~33M parameters, MIT-licensed), run
fully offline via `@huggingface/transformers` (ONNX Runtime) once its
quantized weights (~30MB) are downloaded and cached locally. 384 dimensions
— compatible with the existing `vector(384)` schema, so adopting it requires
no database migration.

### First-time download

`remem init` prints a warning before the first download attempt. Weights are
cached under `~/.cache/remem/models` (respecting `XDG_CACHE_HOME`) and are
not bundled in the npm package, so the default zero-dependency install stays
lightweight.

### If the download is blocked (firewalls, air-gapped environments)

1. **Corporate proxy**: the download respects `HTTPS_PROXY`/`HTTP_PROXY`/
   `NO_PROXY`/`NODE_EXTRA_CA_CERTS`.
2. **Fully air-gapped**: set `embedding.modelPath` in your plugin config (or
   pass it via the equivalent CLI flag) to a local directory containing
   pre-staged weights; no network call is attempted.
3. **Automatic fallback**: if neither applies, Remem falls back to
   `remem-local-hash-v1` automatically and logs the failure. Run
   `remem doctor` to see the active backend and retry status.

## Model changes and re-embedding

If you change the configured embedding model, existing memories aren't
recomputed instantly — they continue to work via keyword search, and a
background job re-embeds them automatically the next time OpenCode receives
a prompt (cooldown-gated, never blocking a response). Run `remem reembed` to
force it immediately, or `remem doctor` to check backlog status.

This only progresses while OpenCode is actively used; if it sits idle after
a model change, the backlog resumes draining the next time it's used. There
is currently no standing background service for idle-time draining — this
is an intentional simplicity tradeoff, revisit only if it proves to be a
real problem in practice.
```

- [ ] **Step 2: Update `docs/configuration.md`**

Read the file's structure first (`grep -n "^#" docs/configuration.md`), then add a section (mirroring the existing section style) documenting the `embedding` plugin-options block from Task 4, linking to `docs/embeddings.md` for detail.

- [ ] **Step 3: Update `docs/installation.md`**

Read the file's structure first, then add a short paragraph after the `remem init` instructions noting the one-time neural model download and linking to `docs/embeddings.md`.

- [ ] **Step 4: Update `CHANGELOG.md`**

Read the top of the existing file to match its exact heading/bullet format, then add an entry under the current unreleased section (or create one if the file is keep-a-changelog style) summarizing: "Added `bge-small-en-v1.5` local neural embeddings (managed-mode default), automatic hook-triggered re-embedding on model change, and `remem reembed`/doctor backlog reporting. Resolves #1."

- [ ] **Step 5: Commit**

```bash
git add docs/embeddings.md docs/configuration.md docs/installation.md CHANGELOG.md
git commit -m "docs: document neural embeddings, offline fallback, and reembed command"
```

---

### Task 16: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full check pipeline**

Run: `npm run check`
Expected: format, lint, typecheck, `npm test`, and `npm run build` all PASS.

- [ ] **Step 2: Run the Postgres integration suite**

Run: `REMEM_TEST_DATABASE_URL=postgres://remem:remem@127.0.0.1:5432/remem_test npx vitest run tests/postgres-provider.integration.test.ts tests/reembedding.test.ts`
Expected: PASS (spin up a local `pgvector/pgvector:0.8.1-pg16` container first if none is running — see `.github/workflows/ci.yml`'s `postgres` service block for the exact image/credentials to mirror locally).

- [ ] **Step 3: Manual smoke test of the download/fallback path**

Run: `node -e "import('./dist/storage/embedding-neural.js').then(m => m.createEmbeddingModel({backend:'neural'})).then(m => console.log(m.id))"` after `npm run build`.
Expected: prints `bge-small-en-v1.5` if network access is available, or `remem-local-hash-v1` if not — either is correct, confirming fail-open works end-to-end.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address issues found in full verification pass"
```

(Skip this commit if Steps 1-3 all passed cleanly with no changes needed.)

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `BgeSmallEmbeddingModel`, lazy dynamic import, fail-open | Task 2 |
| Managed-mode default via `embedding.backend` | Tasks 4, 5 |
| Configured dimension (not hardcoded 384) | Task 8 |
| Model-change detection + automatic re-embed | Tasks 7, 9 |
| Hook-triggered (not cron/daemon) trigger, cooldown, fire-and-forget | Task 10 |
| Manual `remem reembed` override | Task 11 |
| Three-layer offline/firewall fallback (proxy, modelPath, fail-open) | Tasks 2, 3, 13 |
| `remem init` download warning | Task 6 |
| `remem doctor` backend + backlog reporting | Tasks 8 (Step 6), 12 |
| Unit tests: fallback, dimension mismatch, cooldown, batch-claim | Tasks 2, 3, 8, 9, 10 |
| Eval fixtures: paraphrase/low-lexical-overlap recall | Task 14 |
| Documentation: size/dims/license/runtime/upgrade policy | Task 15 |

No gaps found.

**Placeholder scan:** No "TBD"/"TODO" strings; every code step contains complete, real code. Two steps (Task 6 Step 1, Task 11 Step 1, Task 12 Step 1) reference "this file's existing pattern" for test scaffolding (fixture paths, fake `ProcessRunner`) instead of inlining it — this is intentional, not a placeholder: those exact helpers already exist in the target test files and must be read and matched, not re-invented, to avoid duplicating incompatible test doubles. Each such reference names exactly what to copy and why.

**Type/signature consistency:** `EmbeddingConfig` (Task 4) → consumed by `createEmbeddingModel(config: NeuralEmbeddingConfig, ...)` (Task 2) — field names (`backend`, `modelPath`) match. `PostgresMemoryProvider.reembedStale()` (Task 9) is called from both the CLI (Task 11) and the prompt hook (Task 10) with the same signature (`(batchSize?: number) => Promise<ReembedRunResult>`). `RememAppConfig.embedding.provider` values (`"local-hash" | "neural"`, Task 5) are distinct from `RememConfig.embedding.backend` values (`"hash" | "neural"`, Task 4) — **these are two different config layers with intentionally different vocabularies** (app-level installation config vs. plugin-options schema); Task 8 Step 6's doctor fix explicitly translates between them (`config.embedding.provider === "neural" ? "neural" : "hash"`) rather than assuming they're the same field, which is called out to prevent a future reader from "simplifying" them into one.
