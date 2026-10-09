// Real Pi package discovery and native read-tool loading, using only local fixture data.
import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import process from "node:process"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, URL } from "node:url"

const repository = fileURLToPath(new URL("..", import.meta.url))
const packageRoot = process.env.REMEM_E2E_PI_PACKAGE_ROOT ?? repository
const skillPath = path.join(packageRoot, "skills", "remem-memory-tools", "SKILL.md")
const sentinel = "Empty results do not prove that prior work never happened."
const temporary = await mkdtemp(path.join(os.tmpdir(), "remem-pi-guidance-"))
const requests = []
const server = createServer((request, response) => {
  const chunks = []
  request.on("data", chunk => chunks.push(chunk))
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests.push(body)
    response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" })
    const base = { id: "guidance-" + requests.length, object: "chat.completion.chunk", created: 0, model: body.model }
    const emit = (delta, finish_reason = null) => response.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + "\n\n")
    const name = requests.length === 1 ? "read" : requests.length === 2 ? "memory_status" : undefined
    if (name) {
      emit({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + name, type: "function", function: { name, arguments: JSON.stringify(name === "read" ? { path: skillPath } : {}) } }] })
      emit({}, "tool_calls")
    } else {
      emit({ role: "assistant", content: "Guidance and memory health checked." })
      emit({}, "stop")
    }
    response.end("data: [DONE]\n\n")
  })
})
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  const agentDir = path.join(temporary, "agent")
  await mkdir(agentDir)
  // Explicit duplicate skill path exercises Pi's canonical-file de-duplication.
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot], skills: [path.join(packageRoot, "skills")] }))
  const configFile = path.join(temporary, "config.json")
  await writeFile(configFile, JSON.stringify({ version: 1, storage: { mode: "external", connectionString: "postgres://unused/unused" }, providers: [], embedding: { provider: "local-hash", model: "remem-local-hash-v1", dimensions: 384 } }))
  const companion = path.join(temporary, "mock-provider.mjs")
  await writeFile(companion, "export default function(pi) { pi.registerProvider(\"mock-guidance\", { baseUrl: \"http://127.0.0.1:" + address.port + "/v1\", apiKey: \"mock-key\", api: \"openai-completions\", models: [{ id: \"mock-model\", name: \"Mock\", reasoning: false, input: [\"text\"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] }); }")
  const child = spawn("pi", ["--provider", "mock-guidance", "--model", "mock-model", "-e", companion, "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-session", "--tools", "read,memory_status", "-p", "Check the ReMem guidance and memory status."], { cwd: temporary, env: { ...process.env, HOME: temporary, PI_CODING_AGENT_DIR: agentDir, REMEM_CONFIG: configFile }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 })
  const output = []
  const errors = []
  child.stdout.on("data", chunk => output.push(chunk))
  child.stderr.on("data", chunk => errors.push(chunk))
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
  assert.equal(exitCode, 0, Buffer.concat(errors).toString("utf8"))
  assert.equal(requests.length, 3, "native read and memory-status tool loops must complete")
  const initial = JSON.stringify(requests[0].messages)
  assert.equal((initial.match(/<name>remem-memory-tools<\/name>/g) ?? []).length, 1, "package and explicit skill discovery must load one catalog entry")
  assert.ok(!initial.includes(sentinel), "skill body is loaded on demand, not dumped into every prompt")
  const readResult = requests[1].messages.find(message => message.role === "tool")
  assert.ok(JSON.stringify(readResult).includes(sentinel), "native read must load actual installed skill body")
  const toolResults = requests[2].messages.filter(message => message.role === "tool")
  assert.equal(toolResults.length, 2)
  assert.equal(toolResults.filter(message => JSON.stringify(message).includes(sentinel)).length, 1)
  assert.ok(JSON.stringify(toolResults).includes("catalog"), "package extension must register its real memory tool")
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"))
  assert.deepEqual(manifest.pi.skills, ["./skills"])
  assert.ok(!Buffer.concat(errors).toString("utf8").includes("collision"), "duplicate discovery must not produce a skill collision")
  process.stdout.write("ok - pi guidance: " + (process.env.REMEM_E2E_PI_PACKAGE_ROOT ? "installed tarball" : "local package") + ", one discovery/body load, native read + memory_status\n")
} finally {
  await new Promise(resolve => server.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
