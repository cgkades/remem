// Explicit asset preparation only. No private memory, transcript, prompt or
// generation request is sent to a hosted model. Host inference is offline.
import process from "node:process"
import console from "node:console"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { pipeline, env } from "@huggingface/transformers"
import { configureProxyFromEnvironment } from "../dist/storage/embedding-neural.js"
configureProxyFromEnvironment()
const model = "onnx-community/Qwen2.5-0.5B-Instruct",
  revision = "22942cb7d7ba4cc81bb4673549ca4d4614469b5e"
const cache = process.env.REMEM_GENERATION_CACHE
if (!cache || !path.isAbsolute(cache))
  throw new TypeError("Set REMEM_GENERATION_CACHE to an absolute asset-cache directory")
env.cacheDir = cache
env.allowLocalModels = false
const generator = await pipeline("text-generation", model, {
  revision,
  dtype: "q4",
  device: "cpu",
  session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
})
await generator.dispose()
const modelPath = path.join(cache, model, revision)
await writeFile(
  path.join(modelPath, "remem-model.json"),
  JSON.stringify(
    {
      model,
      revision,
      dtype: "q4",
      preparation: "explicit public asset download; inference uses local files only",
    },
    null,
    2,
  ) + "\n",
)
console.info(JSON.stringify({ modelPath, model, revision }))
