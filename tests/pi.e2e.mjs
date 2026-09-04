// End-to-end test for the Pi host adapter (src/hosts/pi/index.ts), mirroring
// tests/opencode-v2.e2e.mjs's approach: drive the real `pi` CLI binary
// against a local, deterministic OpenAI-compatible mock model server instead
// of a real provider, so this test never needs (or risks leaking) real API
// credentials and never touches the operator's real `~/.pi/agent` directory
// (HOME is overridden to a scratch directory for the spawned `pi` process).
import { spawn } from "node:child_process"
import { Buffer } from "node:buffer"
import { createServer } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath, URL } from "node:url"

const RELATED_PROMPT = "Let's continue the Phoenix database work. Then call memory_status."
const SENTINEL = "use logical replication"
const repository = fileURLToPath(new URL("..", import.meta.url))
const fixtureDirectory = path.join(repository, "tests", "fixtures", "memory")

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * Minimal OpenAI Chat Completions streaming mock. Scripted by request
 * count: the first request (no `tool` role message yet) always responds
 * with a `memory_status` tool call; every request after that responds with
 * a final assistant message. Records every request body it received so the
 * test can assert on what was actually sent to the model (the injected
 * memory context, the tool result, etc.) rather than trusting model output.
 */
function startMockModelServer() {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      requests.push(body)
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "keep-alive",
      })

      const hasToolResult = body.messages.some((message) => message.role === "tool")
      const id = `chatcmpl-${requests.length}`
      const created = Math.floor(Date.now() / 1000)
      const base = { id, object: "chat.completion.chunk", created, model: body.model }

      if (!hasToolResult) {
        response.write(
          sseChunk({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_memory_status",
                      type: "function",
                      function: { name: "memory_status", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        )
        response.write(
          sseChunk({
            ...base,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
                finish_reason: null,
              },
            ],
          }),
        )
        response.write(
          sseChunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          }),
        )
      } else {
        response.write(
          sseChunk({
            ...base,
            choices: [
              { index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null },
            ],
          }),
        )
        response.write(
          sseChunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        )
      }
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", resolve))
}

async function run() {
  const scratchHome = await mkdtemp(path.join(os.tmpdir(), "remem-pi-e2e-home-"))
  const configDir = await mkdtemp(path.join(os.tmpdir(), "remem-pi-e2e-config-"))
  const extensionsDir = await mkdtemp(path.join(os.tmpdir(), "remem-pi-e2e-ext-"))
  const mock = await startMockModelServer()

  try {
    // remem's own installed config (read directly, no options-passing
    // convention for Pi extensions -- see docs/pi-integration.md).
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify(
        {
          version: 1,
          storage: { mode: "external", connectionString: "postgres://unused/unused" },
          providers: [
            {
              type: "markdown",
              id: "fixtures",
              paths: [fixtureDirectory],
              exclude: [],
              scope: "workspace",
              maxFileBytes: 262144,
              maxFiles: 100,
            },
          ],
          embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 },
        },
        null,
        2,
      ),
    )

    // Companion extension registering the mock model as a Pi provider. Kept
    // separate from src/hosts/pi/ since it exists only for this test harness.
    await writeFile(
      path.join(extensionsDir, "mock-provider.mjs"),
      `export default function (pi) {
  pi.registerProvider("mock", {
    baseUrl: ${JSON.stringify(mock.url)},
    apiKey: "mock-key",
    api: "openai-completions",
    models: [
      {
        id: "mock-model",
        name: "Mock Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  })
}
`,
    )

    const rememExtensionPath = path.join(repository, "dist", "hosts", "pi", "index.js")
    const child = spawn(
      "pi",
      [
        "--provider",
        "mock",
        "--model",
        "mock-model",
        "-e",
        rememExtensionPath,
        "-e",
        path.join(extensionsDir, "mock-provider.mjs"),
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-session",
        "--tools",
        "memory_status",
        "--no-builtin-tools",
        "-p",
        RELATED_PROMPT,
      ],
      {
        env: {
          ...process.env,
          HOME: scratchHome,
          REMEM_CONFIG: path.join(configDir, "config.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    )
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk))
    const exitCode = await waitForExit(child)
    const stdout = Buffer.concat(stdoutChunks).toString("utf8")
    const stderr = Buffer.concat(stderrChunks).toString("utf8")

    if (exitCode !== 0) {
      throw new Error(`pi exited ${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    }

    if (mock.requests.length < 2) {
      throw new Error(
        `expected at least 2 requests to the mock model (dispatch + tool-loop continuation), got ${mock.requests.length}`,
      )
    }

    // 1. before_agent_start injection: the first request's messages must
    //    contain the attributed, bounded Remem context -- not the raw
    //    prompt alone.
    const firstRequestText = JSON.stringify(mock.requests[0].messages)
    if (!firstRequestText.includes(SENTINEL)) {
      throw new Error(`first request did not contain injected memory context: ${firstRequestText}`)
    }
    if (!firstRequestText.includes("untrusted evidence")) {
      throw new Error(`first request did not contain the untrusted-memory attribution framing`)
    }

    // 2. memory_status tool call: the second request must include a real
    //    tool result from the actual orchestrator, not a stub.
    const secondRequestText = JSON.stringify(mock.requests[1].messages)
    const toolMessage = mock.requests[1].messages.find((message) => message.role === "tool")
    if (!toolMessage) {
      throw new Error(`second request did not contain a tool result message: ${secondRequestText}`)
    }
    const toolPayload = JSON.parse(toolMessage.content)
    if (typeof toolPayload.catalog?.entries !== "number") {
      throw new Error(
        `memory_status tool result was not the expected shape: ${toolMessage.content}`,
      )
    }

    process.stdout.write(
      `ok - pi e2e: ${mock.requests.length} model request(s), injection + tool call verified\n`,
    )
  } finally {
    await mock.close()
    await Promise.all(
      [scratchHome, configDir, extensionsDir].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    )
  }
}

await run()
