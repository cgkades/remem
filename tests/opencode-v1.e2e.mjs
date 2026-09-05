import { strict as assert } from "node:assert"
import { Buffer } from "node:buffer"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { URL, fileURLToPath, pathToFileURL } from "node:url"

const RUNTIME_VERSION = "1.18.27"
const SENTINEL = "REMEM_V1_E2E_PHOENIX_SENTINEL"
const repository = fileURLToPath(new URL("..", import.meta.url))
const opencode = process.env.OPENCODE_BIN ?? "opencode"
const pluginSpec =
  process.env.REMEM_E2E_PLUGIN_SPEC ??
  pathToFileURL(path.join(repository, "dist", "server.js")).href

function command(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }
      if (code === 0) resolve(result)
      else
        reject(
          new Error(
            `${commandName} ${args.join(" ")} exited ${code}\n${result.stdout}\n${result.stderr}`,
          ),
        )
    })
  })
}

function sse(response, data) {
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function main() {
  const version = await command(opencode, ["--version"])
  assert.equal(version.stdout.trim(), RUNTIME_VERSION, `expected OpenCode ${RUNTIME_VERSION}`)

  const requests = []
  const model = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ data: [{ id: "mock-1" }] }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    response.writeHead(200, { "content-type": "text/event-stream" })
    sse(response, {
      id: "remem-v1-e2e",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
    })
    sse(response, {
      id: "remem-v1-e2e",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })
    response.end("data: [DONE]\n\n")
  })
  await new Promise((resolve, reject) =>
    model.listen(0, "127.0.0.1", (error) => (error ? reject(error) : resolve())),
  )

  const address = model.address()
  assert(address && typeof address !== "string")
  const root = await mkdtemp(path.join(os.tmpdir(), "remem-opencode-v1-"))
  try {
    const configDirectory = path.join(root, "config", "opencode")
    const worktree = path.join(root, "worktree")
    await mkdir(path.join(worktree, "memory"), { recursive: true })
    await writeFile(
      path.join(worktree, "memory", "phoenix.md"),
      [
        "---",
        "title: Project Phoenix",
        "aliases: phoenix database, phoenix migration",
        "tags: database, migration, postgres",
        "type: decision",
        "importance: 0.9",
        "summary: Active database migration workstream",
        "---",
        "",
        "# Project Phoenix",
        `Decision: ${SENTINEL} use logical replication.`,
        "",
      ].join("\n"),
    )
    await mkdir(configDirectory, { recursive: true })
    await writeFile(
      path.join(configDirectory, "opencode.json"),
      JSON.stringify({
        plugin: [
          [
            pluginSpec,
            {
              providers: [
                {
                  type: "markdown",
                  id: "notes",
                  paths: [path.join(worktree, "memory")],
                  scope: "workspace",
                },
              ],
              planner: { minimumConfidence: 0, maxTopics: 3 },
            },
          ],
        ],
        provider: {
          mock: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" },
            models: {
              "mock-1": {
                name: "Mock",
                tool_call: true,
                limit: { context: 32_000, output: 1_000 },
              },
            },
          },
        },
        model: "mock/mock-1",
      }),
    )
    await command(opencode, ["run", "Let's continue the Phoenix database work."], {
      cwd: worktree,
      env: {
        ...process.env,
        HOME: root,
        OPENCODE_CONFIG: path.join(configDirectory, "opencode.json"),
        PWD: worktree,
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
      },
    })
  } finally {
    await new Promise((resolve) => model.close(resolve))
    await rm(root, { recursive: true, force: true })
  }

  const dispatch = requests.findLast((request) =>
    request.messages.some(
      (message) =>
        message.role === "system" && String(message.content).includes("You are opencode"),
    ),
  )
  assert(dispatch, "the mock model did not receive the user dispatch")
  assert(
    JSON.stringify(dispatch.messages).includes(SENTINEL),
    `v1 did not inject recalled memory: ${JSON.stringify(dispatch.messages)}`,
  )
  const tools = dispatch.tools ?? []
  for (const name of ["memory_search", "memory_status", "memory_explain"]) {
    assert(
      tools.some((tool) => tool.function?.name === name),
      `v1 did not register ${name}`,
    )
  }
  process.stdout.write(`OpenCode v${RUNTIME_VERSION} v1 Remem E2E passed.\n`)
}

await main()
