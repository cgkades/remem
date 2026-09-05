import { spawn } from "node:child_process"
import { Buffer } from "node:buffer"
import { createServer } from "node:http"
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import { URL, fileURLToPath, pathToFileURL } from "node:url"

const RUNTIME_VERSION = "0.0.0-beta-18743"
const SENTINEL = "REMEM_E2E_PHOENIX_SENTINEL"
const RELATED_PROMPT = "Let's continue the Phoenix database work."
const UNRELATED_PROMPT = "Summarize this unrelated weather report."
const OUTAGE_PROMPT = "Continue even if long-term memory is unavailable."
// Issue #13: RememPlugin.setup() registers two independent
// context.session.hook("prompt", ...) callbacks -- the capture-enqueue hook
// and the cooldown-gated re-embed trigger. Whether OpenCode's real runtime
// treats hook registration as additive (both fire) or "last write wins" (the
// second registration silently replaces the first) could only be inferred
// from the plugin API's type signatures, not verified, since the runtime
// dispatch implementation ships compiled into the opencode2 binary. This
// prompt is deliberately capturable (classify() recognizes "we decided") so
// firing the capture hook is independently observable in remem.candidate_memories,
// alongside the re-embed hook's effect on a pre-seeded stale row.
const HOOKS_PROMPT = "Decision: we decided to use blue-green deployments for the Phoenix rollout."
// Issue #9: the suite's only coverage of the postgres provider type was the
// forced-outage/fail-open scenario, which is one-sided -- it never proved a
// real, reachable PostgreSQL/pgvector provider participates successfully in
// retrieval against the live v2 runtime, only that the plugin degrades
// gracefully when one is unreachable. This memory is written directly
// through a real PostgresMemoryProvider (not the markdown fixture), and its
// title is a literal substring of the prompt below so the deterministic
// planner's phrase-match scores it high confidence without depending on
// semantic/token-overlap heuristics.
const POSTGRES_SENTINEL = "REMEM_E2E_AURORA_SENTINEL"
const POSTGRES_MEMORY_TITLE = "Aurora database migration"
const POSTGRES_RETRIEVAL_PROMPT = "Let's continue the Aurora database migration work."
// Issue #11 regression coverage: after the native "read" tool loop completes,
// call the Remem-registered memory_status tool by its bare name to verify it
// is actually invocable (not just present in the advertised tool schema) now
// that it registers with codemode: false. (memory_search is deliberately not
// exercised here: its result legitimately surfaces memory content, which
// would trip the unrelated "ephemeral injection is not persisted" assertion
// below — that assertion checks the prompt-injection message specifically,
// not tool call results.)
const TOOL_CALL_STEPS = [
  { id: "call_read", name: "read", arguments: '{"path":"tool-loop.txt"}' },
  { id: "call_memory_status", name: "memory_status", arguments: "{}" },
]
// Issue #8: the mock model previously always returned a 200 streaming
// response, so no scenario ever exercised the dispatch/tool-loop's handling
// of a provider-side error. This prompt drives a deterministic non-2xx
// response from the mock.
const ERROR_PROMPT = "Trigger a simulated provider outage for this turn."
const SERVER_PASSWORD = "remem-e2e"
const SERVER_AUTHORIZATION = `Basic ${Buffer.from(`opencode:${SERVER_PASSWORD}`).toString("base64")}`
const repository = fileURLToPath(new URL("..", import.meta.url))

function delay(milliseconds) {
  return sleep(milliseconds)
}

function command(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 300_000,
      killSignal: "SIGKILL",
    })
    const stdoutChunks = []
    const stderrChunks = []
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk))
    child.on("error", reject)
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8")
      const stderr = Buffer.concat(stderrChunks).toString("utf8")
      if (code === 0) return resolve({ stdout, stderr })
      const reason = signal ? `killed by ${signal} (possible timeout)` : `exited ${code}`
      reject(new Error(`${commandName} ${args.join(" ")} ${reason}\n${stdout}\n${stderr}`))
    })
  })
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (!address || typeof address === "string") throw new Error("could not reserve a local port")
  return address.port
}

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", resolve))
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([waitForExit(child), delay(5_000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await waitForExit(child)
  }
}

function start(commandName, args, options) {
  const child = spawn(commandName, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const chunks = []
  let failure
  child.stdout.on("data", (chunk) => chunks.push(chunk))
  child.stderr.on("data", (chunk) => chunks.push(chunk))
  child.on("error", (error) => (failure = error))
  return { child, output: () => Buffer.concat(chunks).toString("utf8"), failure: () => failure }
}

function isTransientHealthCheckError(error) {
  return error?.name === "AbortError" || error?.cause?.code === "ECONNREFUSED"
}

async function waitForHealth(url, processHandle) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (
      processHandle.failure() ||
      processHandle.child.exitCode !== null ||
      processHandle.child.signalCode !== null
    ) {
      throw new Error(
        `opencode2 exited before readiness\n${processHandle.failure() ?? ""}\n${processHandle.output()}`,
      )
    }
    try {
      const response = await globalThis.fetch(`${url}/api/health`, {
        headers: { authorization: SERVER_AUTHORIZATION },
        signal: globalThis.AbortSignal.timeout(1_000),
      })
      if (response.ok) return
    } catch (error) {
      if (!isTransientHealthCheckError(error)) throw error
    }
    await delay(100)
  }
  throw new Error(`opencode2 did not become ready\n${processHandle.output()}`)
}

function toolCall(messagesResponse, callId) {
  for (const message of messagesResponse.data ?? []) {
    for (const part of message.content ?? []) {
      if (part.type === "tool" && part.id === callId) return part
    }
  }
  return undefined
}

async function request(url, pathname, options = {}) {
  const response = await globalThis.fetch(`${url}${pathname}`, {
    ...options,
    signal: options.signal ?? globalThis.AbortSignal.timeout(30_000),
    headers: {
      authorization: SERVER_AUTHORIZATION,
      "content-type": "application/json",
      ...options.headers,
    },
  })
  if (!response.ok)
    throw new Error(
      `${options.method ?? "GET"} ${pathname} returned ${response.status}: ${await response.text()}`,
    )
  if (response.status === 204) return undefined
  return response.json()
}

function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function handleModelRequest(incoming, response, state) {
  if (incoming.method === "GET" && incoming.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ object: "list", data: [{ id: "mock-1", object: "model" }] }))
    return
  }
  if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
    response.writeHead(404).end()
    return
  }
  // Issue #8: a regression that drops the configured auth header before it
  // reaches the real provider would not be caught if the mock never checked
  // for it -- record every request's Authorization header alongside its
  // body so tests can assert on it.
  state.authorizationHeaders.push(incoming.headers.authorization)
  const chunks = []
  for await (const chunk of incoming) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  // Issue #8: exercise the dispatch/tool-loop's error-handling path against
  // a real non-2xx provider response, not just the success path -- this
  // mock previously always returned 200.
  if (
    body.messages.some(
      (message) => typeof message.content === "string" && message.content.includes(ERROR_PROMPT),
    )
  ) {
    response.writeHead(500, { "content-type": "text/event-stream" })
    response.end(
      `data: ${JSON.stringify({
        error: {
          message: "simulated provider outage (issue #8 E2E fixture)",
          type: "server_error",
        },
      })}\n\ndata: [DONE]\n\n`,
    )
    return
  }
  state.requests.push(body)
  const messages = JSON.stringify(body.messages)
  const isRelated = messages.includes(RELATED_PROMPT)
  const resultIds = new Set(
    body.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.tool_call_id),
  )
  const nextStep = isRelated
    ? TOOL_CALL_STEPS.find(
        (step, index) =>
          !resultIds.has(step.id) &&
          TOOL_CALL_STEPS.slice(0, index).every((prior) => resultIds.has(prior.id)),
      )
    : undefined
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  })
  const base = {
    id: "chatcmpl-remem-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock-1",
  }
  if (nextStep) {
    // Issue #8: real OpenAI/AI-SDK-compatible providers stream
    // function.arguments as incremental string deltas across multiple SSE
    // chunks -- only the first delta carries id/type/function.name. A mock
    // that always sends the whole JSON blob in one chunk would never catch a
    // regression in the client's delta-accumulation logic. Split the
    // argument string roughly in half to force at least two fragments.
    const midpoint = Math.max(1, Math.floor(nextStep.arguments.length / 2))
    const firstFragment = nextStep.arguments.slice(0, midpoint)
    const secondFragment = nextStep.arguments.slice(midpoint)
    sse(response, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: nextStep.id,
                type: "function",
                function: { name: nextStep.name, arguments: firstFragment },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
    sse(response, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: secondFragment } }],
          },
          finish_reason: null,
        },
      ],
    })
    sse(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
  } else {
    sse(response, {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "mock response" },
          finish_reason: null,
        },
      ],
    })
    sse(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
    // Issue #8: real providers emit a final usage-only frame (empty
    // `choices`) before [DONE] when the request opts into
    // stream_options.include_usage. Verified against the real opencode2
    // runtime: sending this frame after a tool_calls finish, rather than a
    // stop finish, makes the client immediately fail the turn with a
    // spurious "Compaction produced no summary" error -- so this fixture
    // only emits it for a terminal (non-tool-call) turn, matching what the
    // client can actually tolerate.
    if (body.stream_options?.include_usage) {
      sse(response, {
        ...base,
        choices: [],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
      })
    }
  }
  response.end("data: [DONE]\n\n")
}

async function mockModel() {
  const state = { requests: [], authorizationHeaders: [] }
  const server = createServer((incoming, response) => {
    handleModelRequest(incoming, response, state).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" })
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : "mock model failure" }),
      )
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("mock model did not bind a port")
  return {
    requests: state.requests,
    authorizationHeaders: state.authorizationHeaders,
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function unavailablePostgres() {
  let attempts = 0
  const server = net.createServer((socket) => {
    attempts++
    socket.destroy()
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("unavailable PostgreSQL fixture did not bind")
  return {
    connectionString: `postgresql://unused:unused@127.0.0.1:${address.port}/remem`,
    attempts: () => attempts,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function pluginOptions(memoryPath, unavailableConnection) {
  return {
    providers: [
      ...(memoryPath
        ? [
            {
              type: "markdown",
              id: "fixture-memory",
              paths: [memoryPath],
              scope: "workspace",
            },
          ]
        : []),
      {
        type: "postgres",
        id: "unavailable-postgres",
        connectionString: unavailableConnection,
        primary: false,
        maxConnections: 1,
        catalogLimit: 10,
      },
    ],
    providerTimeoutMs: 50,
    capture: { enabled: false },
  }
}

async function createWorkspace(root, name, plugin, modelURL, includeMemory, unavailableConnection) {
  const workspace = path.join(root, name)
  const memory = path.join(workspace, ".remem", "memory")
  if (includeMemory) {
    await mkdir(memory, { recursive: true })
    await writeFile(
      path.join(memory, "phoenix.md"),
      `# Phoenix database migration\n\nUse logical replication. ${SENTINEL}\n`,
    )
  } else await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, "tool-loop.txt"), "native tool loop fixture\n")
  await writeFile(
    path.join(workspace, "opencode.json"),
    `${JSON.stringify(
      {
        model: "mock/mock-1",
        providers: {
          mock: {
            env: ["REMEM_E2E_MOCK_KEY"],
            package: "@opencode-ai/ai/providers/openai-compatible",
            settings: { baseURL: modelURL },
            models: {
              "mock-1": {
                name: "Remem E2E mock",
                modelID: "mock-1",
                limit: { context: 16_384, output: 1_024 },
              },
            },
          },
        },
        plugins: [
          {
            package: pathToFileURL(plugin).href,
            options: pluginOptions(
              includeMemory ? ".remem/memory" : undefined,
              unavailableConnection,
            ),
          },
        ],
      },
      null,
      2,
    )}\n`,
  )
  return workspace
}

function hooksPluginOptions(connectionString) {
  return {
    providers: [
      {
        type: "postgres",
        id: "hooks-postgres",
        connectionString,
        primary: true,
        maxConnections: 2,
        catalogLimit: 10,
      },
    ],
    providerTimeoutMs: 5_000,
    capture: { enabled: true },
  }
}

async function createHooksWorkspace(root, plugin, modelURL, connectionString) {
  const workspace = path.join(root, "hooks")
  await mkdir(workspace, { recursive: true })
  await writeFile(
    path.join(workspace, "opencode.json"),
    `${JSON.stringify(
      {
        model: "mock/mock-1",
        providers: {
          mock: {
            env: ["REMEM_E2E_MOCK_KEY"],
            package: "@opencode-ai/ai/providers/openai-compatible",
            settings: { baseURL: modelURL },
            models: {
              "mock-1": {
                name: "Remem E2E mock",
                modelID: "mock-1",
                limit: { context: 16_384, output: 1_024 },
              },
            },
          },
        },
        plugins: [
          { package: pathToFileURL(plugin).href, options: hooksPluginOptions(connectionString) },
        ],
      },
      null,
      2,
    )}\n`,
  )
  return workspace
}

async function pollUntil(description, check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let lastResult
  let attempts = 0
  while (Date.now() < deadline) {
    lastResult = await check()
    attempts++
    if (lastResult) return lastResult
    await delay(200)
  }
  throw new Error(
    `timed out waiting for: ${description} (${attempts} attempts over ${timeoutMs}ms, ` +
      `last result: ${JSON.stringify(lastResult)})`,
  )
}

async function startOpenCodeServer(executable, workspace, environment, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await unusedPort()
    const serverURL = `http://127.0.0.1:${port}`
    const handle = start(
      executable,
      [
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
        "--log-level",
        "debug",
        "--print-logs",
      ],
      { cwd: workspace, env: environment },
    )
    try {
      await waitForHealth(serverURL, handle)
      return { handle, serverURL }
    } catch (error) {
      await stop(handle.child)
      // unusedPort() reserves a port and releases it before opencode2 binds to it, so another
      // process on the runner can race in and grab it between those two steps. Retry with a
      // freshly reserved port when that happens instead of failing the whole run.
      const isPortConflict = /EADDRINUSE/.test(handle.output())
      if (!isPortConflict || attempt === attempts) throw error
    }
  }
  throw new Error("unreachable")
}

async function createSession(serverURL, workspace) {
  const created = await request(serverURL, "/api/session", {
    method: "POST",
    body: JSON.stringify({
      location: { directory: workspace },
      agent: "build",
      model: { providerID: "mock", id: "mock-1" },
    }),
  })
  if (!created.data?.id) throw new Error("OpenCode did not return a session id")
  return created.data.id
}

async function prompt(serverURL, sessionID, text, waitTimeoutMs = 30_000) {
  await request(serverURL, `/api/session/${sessionID}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  })
  // The beta API admits the prompt before its execution coordinator claims the session, so a
  // /wait call can race ahead of the coordinator and return early. Retry /wait itself, rather
  // than gambling on a single fixed delay being long enough under CI load.
  const deadline = Date.now() + 10_000
  let lastError
  while (Date.now() < deadline) {
    try {
      await request(serverURL, `/api/session/${sessionID}/wait`, {
        method: "POST",
        signal: globalThis.AbortSignal.timeout(waitTimeoutMs),
      })
      return
    } catch (error) {
      lastError = error
      await delay(100)
    }
  }
  throw new Error(`session ${sessionID} never became ready to wait on\n${lastError}`)
}

async function main() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "remem-opencode-v2-e2e-"))
  const npmEnvironment = {
    HOME: path.join(temporary, "npm-home"),
    PATH: process.env.PATH,
    npm_config_cache: path.join(temporary, "npm-cache"),
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_update_notifier: "false",
    ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
    ...(process.env.NODE_EXTRA_CA_CERTS
      ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
      : {}),
  }
  let model
  let unavailable
  let opencode
  let hooksPool
  let completed = false
  try {
    await command("npm", ["run", "build"], { cwd: repository, env: npmEnvironment })
    const packed = await command(
      "npm",
      ["pack", "--ignore-scripts=true", "--pack-destination", temporary],
      {
        cwd: repository,
        env: npmEnvironment,
      },
    )
    const archive = packed.stdout.trim().split("\n").at(-1)
    if (!archive) throw new Error("npm pack did not return an archive")
    const application = path.join(temporary, "consumer")
    const runtime = path.join(temporary, "runtime")
    await mkdir(application)
    await mkdir(runtime)
    await writeFile(
      path.join(runtime, "package.json"),
      JSON.stringify({
        name: "remem-opencode-v2-runtime",
        private: true,
      }),
    )
    await command(
      "npm",
      [
        "install",
        "--ignore-scripts=true",
        "--no-audit",
        "--no-fund",
        path.join(temporary, archive),
      ],
      { cwd: application, env: npmEnvironment },
    )
    await command(
      "npm",
      [
        "install",
        "--ignore-scripts=true",
        "--no-audit",
        "--no-fund",
        `@opencode-ai/cli@${RUNTIME_VERSION}`,
      ],
      { cwd: runtime, env: npmEnvironment },
    )
    await command(process.execPath, ["node_modules/@opencode-ai/cli/postinstall.mjs"], {
      cwd: runtime,
      env: npmEnvironment,
    })
    const executable = path.join(runtime, "node_modules", ".bin", "opencode2")
    const version = await command(executable, ["--version"], { env: npmEnvironment })
    if (!version.stdout.includes(RUNTIME_VERSION)) {
      throw new Error(`expected OpenCode beta ${RUNTIME_VERSION}, received ${version.stdout}`)
    }
    model = await mockModel()
    unavailable = await unavailablePostgres()
    const plugin = path.join(application, "node_modules", "opencode-remem", "dist")
    const workspace = await createWorkspace(
      temporary,
      "workspace",
      plugin,
      model.url,
      true,
      unavailable.connectionString,
    )
    const outageWorkspace = await createWorkspace(
      temporary,
      "outage",
      plugin,
      model.url,
      false,
      unavailable.connectionString,
    )
    const environment = {
      ...npmEnvironment,
      HOME: path.join(temporary, "home"),
      XDG_CONFIG_HOME: path.join(temporary, "xdg-config"),
      XDG_DATA_HOME: path.join(temporary, "xdg-data"),
      XDG_STATE_HOME: path.join(temporary, "xdg-state"),
      OPENCODE_DB: path.join(temporary, "opencode.db"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
      REMEM_E2E_MOCK_KEY: "e2e",
    }
    const server = await startOpenCodeServer(executable, workspace, environment)
    opencode = server.handle
    const serverURL = server.serverURL

    const relatedSession = await createSession(serverURL, workspace)
    await prompt(serverURL, relatedSession, RELATED_PROMPT)
    const plugins = await request(
      serverURL,
      `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(workspace)}`,
    )
    if (
      !plugins.data?.some(
        (pluginInfo) => pluginInfo.id === "opencode-remem" && pluginInfo.state?.status === "active",
      )
    ) {
      throw new Error(`Remem plugin did not load: ${JSON.stringify(plugins)}`)
    }

    const relatedRequests = model.requests.filter((body) =>
      body.messages.some(
        (message) =>
          typeof message.content === "string" && message.content.includes("<memory-catalog>"),
      ),
    )
    if (relatedRequests.length < 2) {
      const messages = await request(serverURL, `/api/session/${relatedSession}/message?order=asc`)
      throw new Error(
        `expected a model tool loop, observed ${relatedRequests.length} request(s)\n${JSON.stringify(messages)}\n${opencode.output()}`,
      )
    }
    if (!relatedRequests.every((body) => JSON.stringify(body.messages).includes(SENTINEL))) {
      throw new Error(
        `related model dispatch did not receive injected Remem memory\n${JSON.stringify(relatedRequests)}\n${opencode.output()}`,
      )
    }
    // Issue #8: confirm the configured provider credential (REMEM_E2E_MOCK_KEY,
    // set via the "mock" provider's env option) actually reaches the mock as
    // an Authorization header, rather than only being present in the plugin
    // config that OpenCode never forwards. Verified against the real
    // opencode2 runtime: it sends this as a "Bearer <key>" header.
    if (model.authorizationHeaders.length === 0) {
      throw new Error("the mock model never received any requests to check for an auth header")
    }
    if (!model.authorizationHeaders.every((header) => header === "Bearer e2e")) {
      throw new Error(
        `expected every mock model request to carry the configured credential: ` +
          `${JSON.stringify(model.authorizationHeaders)}`,
      )
    }
    for (const step of TOOL_CALL_STEPS) {
      if (
        !relatedRequests.some((body) =>
          (body.tools ?? []).some((tool) => tool.function?.name === step.name),
        )
      ) {
        throw new Error(
          `Remem ${step.name} tool was not advertised in the live runtime's tool schema\n${JSON.stringify(relatedRequests.map((body) => body.tools))}`,
        )
      }
    }
    const relatedMessages = await request(
      serverURL,
      `/api/session/${relatedSession}/message?order=asc`,
    )
    if (!JSON.stringify(relatedMessages).includes("native tool loop fixture")) {
      throw new Error("native tool loop did not execute successfully")
    }
    for (const step of TOOL_CALL_STEPS.slice(1)) {
      const call = toolCall(relatedMessages, step.id)
      if (!call) {
        throw new Error(
          `expected the mock model to call ${step.name} by bare name\n${JSON.stringify(relatedMessages)}`,
        )
      }
      if (call.state?.status !== "completed") {
        throw new Error(
          `Remem ${step.name} tool was registered but not invocable by bare name (issue #11 regression): ${JSON.stringify(call)}`,
        )
      }
    }
    const context = await request(serverURL, `/api/session/${relatedSession}/context`)
    const persistedUserMessages = context.data?.filter((message) => message.type === "user") ?? []
    if (!persistedUserMessages.some((message) => message.text === RELATED_PROMPT)) {
      throw new Error(`canonical user prompt was not preserved: ${JSON.stringify(context)}`)
    }
    if (JSON.stringify(context).includes(SENTINEL)) {
      throw new Error("injected Remem memory was persisted in session context")
    }

    const unrelatedSession = await createSession(serverURL, workspace)
    await prompt(serverURL, unrelatedSession, UNRELATED_PROMPT)
    const unrelatedRequests = model.requests.filter((body) =>
      JSON.stringify(body.messages).includes(UNRELATED_PROMPT),
    )
    if (unrelatedRequests.length === 0)
      throw new Error("unrelated prompt did not reach the mock model")
    if (unrelatedRequests.some((body) => JSON.stringify(body.messages).includes(SENTINEL))) {
      throw new Error("unrelated prompt received injected Remem memory")
    }

    const outageAttempts = unavailable.attempts()
    const outageSession = await createSession(serverURL, outageWorkspace)
    await prompt(serverURL, outageSession, OUTAGE_PROMPT)
    const outagePlugins = await request(
      serverURL,
      `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(outageWorkspace)}`,
    )
    if (
      !outagePlugins.data?.some(
        (pluginInfo) => pluginInfo.id === "opencode-remem" && pluginInfo.state?.status === "active",
      )
    ) {
      throw new Error(
        `Remem plugin did not load for the outage workspace: ${JSON.stringify(outagePlugins)}`,
      )
    }
    const outageMessages = await request(
      serverURL,
      `/api/session/${outageSession}/message?order=asc`,
    )
    if (!JSON.stringify(outageMessages).includes("mock response")) {
      throw new Error("OpenCode did not fail open after the PostgreSQL provider outage")
    }
    if (unavailable.attempts() <= outageAttempts) {
      throw new Error("the controlled PostgreSQL outage was not attempted")
    }

    // Issue #8: confirm the dispatch/tool-loop's handling of a non-2xx
    // provider response, not just the success path. Empirically (verified
    // against the real opencode2 runtime), the beta API surfaces this
    // asynchronously as the assistant message's terminal `error` field --
    // not synchronously via the /prompt response, and not with the
    // provider's own error message text, just a generic HTTP-status summary
    // -- rather than via a thrown /wait error.
    // The real runtime retries the failed provider call internally before
    // giving up, which empirically took ~29s -- close enough to request()'s
    // default 30s abort timeout to race it, so this scenario needs a longer
    // wait budget than the other prompt() calls in this suite.
    const errorSession = await createSession(serverURL, workspace)
    await prompt(serverURL, errorSession, ERROR_PROMPT, 60_000)
    const errorMessages = await request(serverURL, `/api/session/${errorSession}/message?order=asc`)
    const errorMessage = errorMessages.data?.find((message) => message.finish === "error")
    if (!errorMessage) {
      throw new Error(
        `expected the simulated provider outage to surface as a terminal assistant error: ` +
          `${JSON.stringify(errorMessages)}`,
      )
    }
    if (errorMessage.error?.status !== 500) {
      throw new Error(
        `expected the surfaced error to reflect the mock's HTTP 500 response: ` +
          `${JSON.stringify(errorMessage)}`,
      )
    }

    const databaseUrl = process.env.REMEM_TEST_DATABASE_URL
    if (databaseUrl) {
      const { Pool } = await import("pg")
      const { runMigrations } = await import(
        pathToFileURL(path.join(repository, "dist", "storage", "migrations.js")).href
      )
      const { PostgresMemoryProvider } = await import(
        pathToFileURL(path.join(repository, "dist", "providers", "postgres.js")).href
      )
      hooksPool = new Pool({ connectionString: databaseUrl })
      await hooksPool.query("DROP SCHEMA IF EXISTS remem CASCADE")
      await runMigrations(hooksPool)

      const seedProvider = new PostgresMemoryProvider(
        {
          type: "postgres",
          id: "hooks-postgres",
          connectionString: databaseUrl,
          primary: true,
          maxConnections: 2,
          catalogLimit: 10,
        },
        { pool: hooksPool },
      )
      const seeded = await seedProvider.write({
        title: "Reembed hook target",
        content: "Content re-embedded once the hook-triggered trigger fires.",
        scope: { kind: "workspace", id: "hooks" },
        type: "decision",
      })
      // Global scope, not "workspace": a workspace-scoped write would need
      // its scope.id to match whatever context.worktree the live runtime
      // resolves for this temp directory, which this script cannot predict
      // in advance (and doesn't need to -- global scope has no id to match).
      await seedProvider.write({
        title: POSTGRES_MEMORY_TITLE,
        content: `Use logical replication for the Aurora migration. ${POSTGRES_SENTINEL}`,
        scope: { kind: "global" },
        type: "decision",
      })
      const staled = await hooksPool.query(
        "UPDATE remem.memory_embeddings SET model = 'e2e-stale-marker' WHERE memory_id = $1",
        [seeded.id],
      )
      if (staled.rowCount !== 1) {
        // Without this check, the re-embed poll below would pass spuriously:
        // if seeding never produced an embeddings row, its SELECT would
        // return no rows, and `undefined !== "e2e-stale-marker"` is true --
        // silently "confirming" the re-embed hook fired when it was never
        // actually exercised.
        throw new Error(
          `expected to mark exactly one embedding row stale for memory ${seeded.id}, ` +
            `affected ${staled.rowCount}`,
        )
      }

      const hooksWorkspace = await createHooksWorkspace(temporary, plugin, model.url, databaseUrl)
      const hooksSession = await createSession(serverURL, hooksWorkspace)
      await prompt(serverURL, hooksSession, HOOKS_PROMPT)

      // Both hooks run fire-and-forget from the "prompt" hook callback, so
      // their effects may land slightly after /wait returns -- poll rather
      // than asserting immediately.
      await pollUntil("the capture hook to enqueue a candidate memory", async () => {
        // Unscoped by design, not an oversight: the schema was dropped and
        // freshly migrated immediately above, and this is the only scenario
        // that runs against hooksPool, so any row here can only have come
        // from this scenario's own prompt.
        const result = await hooksPool.query(
          "SELECT count(*)::int AS count FROM remem.candidate_memories",
        )
        return result.rows[0]?.count > 0
      })
      await pollUntil("the re-embed hook to reembed the pre-seeded stale row", async () => {
        const result = await hooksPool.query(
          "SELECT model FROM remem.memory_embeddings WHERE memory_id = $1",
          [seeded.id],
        )
        return result.rows.length === 1 && result.rows[0].model !== "e2e-stale-marker"
      })

      // A separate session from the hooks-verification one above: this
      // asserts dispatch injection specifically, and mixing it into the
      // same session risks the earlier HOOKS_PROMPT's dispatch (recorded
      // before this memory existed) confusing which request to inspect.
      const retrievalSession = await createSession(serverURL, hooksWorkspace)
      await prompt(serverURL, retrievalSession, POSTGRES_RETRIEVAL_PROMPT)
      const retrievalRequests = model.requests.filter((body) =>
        body.messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes(POSTGRES_RETRIEVAL_PROMPT),
        ),
      )
      if (retrievalRequests.length === 0) {
        throw new Error("the PostgreSQL retrieval prompt did not reach the mock model")
      }
      if (
        !retrievalRequests.some((body) => JSON.stringify(body.messages).includes(POSTGRES_SENTINEL))
      ) {
        throw new Error(
          "a memory written through a real, reachable PostgreSQL provider was not retrieved " +
            "and injected into dispatch (issue #9) -- the suite's only prior postgres coverage " +
            `was the unreachable-provider fail-open path\n${JSON.stringify(retrievalRequests)}`,
        )
      }
    } else {
      process.stderr.write(
        "REMEM_TEST_DATABASE_URL not set; skipping the independent-hook-registration " +
          'scenario (issue #13) -- both the capture and re-embed "prompt" hooks require a ' +
          "real, reachable PostgreSQL provider to produce an observable effect.\n",
      )
    }

    completed = true
  } finally {
    if (opencode) await stop(opencode.child)
    if (model) await model.close()
    if (unavailable) await unavailable.close()
    if (hooksPool) await hooksPool.end()
    // Keep the workspace on failure by default so CI/local runs can be triaged after the fact;
    // REMEM_E2E_KEEP additionally forces retention even on success, for local debugging.
    if (completed && !process.env.REMEM_E2E_KEEP) {
      await rm(temporary, { recursive: true, force: true })
    } else {
      process.stderr.write(`retained E2E workspace: ${temporary}\n`)
      if (!completed && process.env.GITHUB_ENV) {
        await appendFile(process.env.GITHUB_ENV, `REMEM_E2E_WORKSPACE=${temporary}\n`)
      }
    }
  }
}

await main()
