# Embeddings

Remem's Stage 1 semantic recall is powered by an `EmbeddingModel`. Two are available:

> **Two different `embedding` config shapes.** The app-config `embedding` object that `remem init`
> writes (`{ provider, model, dimensions }`, in `config.json`) and the OpenCode plugin-options
> `embedding` block (`{ backend, modelPath }`, under `options.embedding` in `opencode.json`) share
> the key name `embedding` but are separate, non-interchangeable objects with no overlapping
> fields. See [`docs/configuration.md`](./configuration.md#embedding-options) for both shapes.

## `remem-local-hash-v1` (default for plugin-only installs)

A deterministic feature-hashing scheme (`src/storage/embedding.ts`). Zero
dependencies, zero network access, 384 dimensions. This is the default when
the OpenCode plugin's `embedding.backend` option is omitted, and it is used
automatically whenever the neural backend isn't configured or fails to load.

## `bge-small-en-v1.5` (default for `remem init`)

A real local neural embedding model (~33M parameters, MIT-licensed), run
fully offline via `@huggingface/transformers` (ONNX Runtime). `remem init`
writes an application config with `embedding: { provider: "neural", model:
"bge-small-en-v1.5", dimensions: 384 }` for both `--mode managed` and
`--mode external`. Quantized (int8, `dtype: "q8"`) ONNX weights (~30MB) are
downloaded on first use rather than the fp32 weights (~90MB). 384 dimensions
— compatible with the existing `vector(384)` schema, so adopting it requires
no database migration.

### First-time download

`remem init` prints this warning before the neural backend's first download
attempt (`warnAboutNeuralDownload` in `src/cli/index.ts`):

> First use will download the bge-small-en-v1.5 embedding model (~30MB) from
> huggingface.co; this happens once. If blocked, see `remem doctor`.

Weights are cached wherever `@huggingface/transformers` puts its own default
cache — by default that is a `.cache/` directory next to the installed
package (under `node_modules/@huggingface/transformers/`), not a
Remem-specific path. Remem does not set `env.cacheDir` or read
`XDG_CACHE_HOME`; if you need control over the cache location, configure it
through `@huggingface/transformers`'s own environment support, or use
`modelPath` (below) to skip the cache/download path entirely. Weights are
never bundled in the npm package, so the default zero-dependency install
stays lightweight.

### If the download is blocked (firewalls, air-gapped environments)

1. **Corporate proxy**: the download respects `HTTPS_PROXY`/`https_proxy`/
   `HTTP_PROXY`/`http_proxy` (`configureProxyFromEnvironment` in
   `src/storage/embedding-neural.ts`).
2. **Fully air-gapped**: set `embedding.modelPath` in your OpenCode plugin
   config (`options.embedding.modelPath` in `opencode.json`) to a local
   directory containing pre-staged weights:

   ```json
   {
     "options": {
       "embedding": {
         "backend": "neural",
         "modelPath": "/absolute/path/to/pre-staged/bge-small-en-v1.5"
       }
     }
   }
   ```

   This is a plugin-config-only setting — there is currently no `remem` CLI
   flag for it. Setting it makes Remem set `env.localModelPath` to that
   directory and `env.allowRemoteModels = false`, so no network call is
   attempted.

3. **Automatic fallback**: if neither applies, Remem falls back to
   `remem-local-hash-v1` automatically and logs the failure. Run
   `remem doctor` to see the active backend (the "embedding configuration"
   check) and retry status.

## Model changes and re-embedding

If you change the configured embedding model, existing memories aren't
recomputed instantly — they continue to work via keyword search, and a
background job re-embeds them automatically the next time OpenCode's
`"prompt"` session hook fires, provided a `PostgresMemoryProvider` is
configured (cooldown-gated via `shouldAttemptReembed`, fire-and-forget, never
blocking a response). Plugin configurations that use only Markdown providers
(no PostgreSQL) have no re-embedding backlog and no hook registration for it.
Run `remem reembed [--batch-size NUMBER]` to force it immediately, or `remem
doctor` to check backlog status — the "embedding backlog" and "embedding
settings persistence" checks report pending counts and whether the recorded
model matches the configured one.

This only progresses while OpenCode is actively used; if it sits idle after
a model change, the backlog resumes draining the next time it's used. There
is no standing background service for idle-time draining.
